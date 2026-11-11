/**
 * Runs `meteor build` on the local machine, with the same arguments MUP derives from
 * `buildOptions`. The only difference is the architecture: it follows the target servers, where
 * MUP always builds for x86_64. The output is a bundle directory; no tarball is created.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig, Platform } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { run } from '../local/exec.js';
import type { Reporter } from '../output/reporter.js';

/** Values of `meteor build --architecture` for the supported server platforms. */
export type MeteorArch = 'os.linux.x86_64' | 'os.linux.aarch64';

/** Lines of build output kept for the error message of a failed build. */
const ERROR_TAIL_LINES = 50;

/** Meteor's architecture for a Docker platform: `linux/arm64` → aarch64, anything else x86_64. */
export function meteorArchFor(p: Platform): MeteorArch {
  return p === 'linux/arm64' ? 'os.linux.aarch64' : 'os.linux.x86_64';
}

/** The Meteor command used for builds: `buildOptions.executable`, or `meteor`. */
export function meteorExecutable(app: Pick<AppConfig, 'buildOptions'>): string {
  return app.buildOptions?.executable || 'meteor';
}

/**
 * Arguments for `meteor build`, in the same order as MUP's `createBuildArgs`, with the
 * architecture as a parameter. The command runs without a shell, so values such as the
 * `--mobile-settings` JSON need no quoting.
 */
export function meteorBuildArgs(app: AppConfig, buildLocation: string, arch: MeteorArch, appPath: string): string[] {
  const b = app.buildOptions ?? ({} as AppConfig['buildOptions']);
  const args = ['build', '--directory', buildLocation, '--architecture', arch];
  if (b.debug) args.push('--debug');
  if (b.mobileSettings) args.push('--mobile-settings', JSON.stringify(b.mobileSettings));
  // MUP behaviour: without `serverOnly` and `mobileSettings` it passes the app's own
  // settings.json (not the deploy settings file) as mobile settings.
  if (b.serverOnly) args.push('--server-only');
  else if (!b.mobileSettings) args.push('--mobile-settings', join(appPath, 'settings.json'));
  if (b.server) args.push('--server', b.server);
  // MUP's schema key is `allowIncompatibleUpdates`, its code reads `allowIncompatibleUpdate`: accept both.
  if (b.allowIncompatibleUpdate || b.allowIncompatibleUpdates) args.push('--allow-incompatible-update');
  return args;
}

/**
 * Runs `meteor build` in the app directory and returns `<buildLocation>/bundle`. With
 * `buildOptions.cleanBuildLocation` the build location is deleted first (MUP does the same and
 * forces it for its default build location). The output goes to the verbose log.
 *
 * @throws CometError when `appPath` is not a Meteor app or the build exits non-zero; the error
 *   carries the last lines of the output, and exit code 127 means the executable was not found.
 */
export async function runMeteorBuild(
  app: AppConfig,
  o: { appPath: string; buildLocation: string; arch: MeteorArch; reporter: Reporter },
): Promise<string> {
  if (!existsSync(join(o.appPath, '.meteor/release'))) {
    throw new CometError(`${o.appPath} is not a Meteor app (.meteor/release not found).`, { hint: 'Check app.path in the config.' });
  }
  if (app.buildOptions?.cleanBuildLocation) {
    await rm(o.buildLocation, { recursive: true, force: true, maxRetries: 10 });
  }
  const exe = meteorExecutable(app);
  const tail: string[] = [];
  const r = await run(exe, meteorBuildArgs(app, o.buildLocation, o.arch, o.appPath), {
    cwd: o.appPath,
    // As MUP: METEOR_HEADLESS turns off Meteor's interactive progress output.
    env: { ...process.env, METEOR_HEADLESS: '1' },
    onLine: (line) => {
      tail.push(line);
      if (tail.length > ERROR_TAIL_LINES) tail.shift();
      o.reporter.verboseLine(null, line);
    },
  });
  if (r.code !== 0) {
    throw new CometError(`meteor build failed (exit code ${r.code}). Last output:\n${tail.join('\n')}`, {
      hint: r.code === 127 ? `"${exe}" was not found. Install Meteor or set buildOptions.executable.` : 'Run with --verbose to see the full build output.',
    });
  }
  return join(o.buildLocation, 'bundle');
}
