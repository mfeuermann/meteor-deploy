import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig, Platform } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { run } from '../local/exec.js';
import type { Reporter } from '../output/reporter.js';

export type MeteorArch = 'os.linux.x86_64' | 'os.linux.aarch64';

const ERROR_TAIL_LINES = 50;

export function meteorArchFor(p: Platform): MeteorArch {
  return p === 'linux/arm64' ? 'os.linux.aarch64' : 'os.linux.x86_64';
}

/** MUP's createBuildArgs (ref. §4.1) with a configurable architecture. */
export function meteorBuildArgs(app: AppConfig, buildLocation: string, arch: MeteorArch, appPath: string): string[] {
  const b = app.buildOptions ?? ({} as AppConfig['buildOptions']);
  const args = ['build', '--directory', buildLocation, '--architecture', arch];
  if (b.debug) args.push('--debug');
  if (b.mobileSettings) args.push('--mobile-settings', JSON.stringify(b.mobileSettings));
  if (b.serverOnly) args.push('--server-only');
  else if (!b.mobileSettings) args.push('--mobile-settings', join(appPath, 'settings.json'));
  if (b.server) args.push('--server', b.server);
  // MUP's schema key is `allowIncompatibleUpdates`, its code reads `allowIncompatibleUpdate`: accept both.
  if (b.allowIncompatibleUpdate || b.allowIncompatibleUpdates) args.push('--allow-incompatible-update');
  return args;
}

/** Runs `meteor build` locally and returns `<buildLocation>/bundle`. */
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
  const exe = app.buildOptions?.executable || 'meteor';
  const tail: string[] = [];
  const r = await run(exe, meteorBuildArgs(app, o.buildLocation, o.arch, o.appPath), {
    cwd: o.appPath,
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
