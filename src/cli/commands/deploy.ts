/**
 * `deploy` and its MUP variants under `meteor`: `meteor deploy` (the same), `meteor push` (stops after
 * the image is on the servers, without activating it) and `meteor build` (stops after the
 * local build). All of them run the deploy pipeline with Ctrl+C turned into a graceful abort.
 */
import type { Argv } from 'yargs';
import type { CommandContext } from '../../core/context.js';
import { deployPipeline } from '../../deploy/pipeline.js';
import type { ConfigCommand } from '../registry.js';
import { assertAllHealthy, rolloutArgs, rolloutOptions } from '../rollout.js';
import { withAbortOnSignals } from '../signals.js';

/**
 * Options of all four deploy commands. In MUP they all accept `--cached-build`; the other
 * options are comet-deploy's own. `--cache-from` / `--cache-to` go to `docker buildx build`
 * unchanged and can be repeated (an array option would also take the words that follow it).
 */
export const deployOptions = (y: Argv) =>
  rolloutOptions(
    y
      .option('cached-build', { type: 'boolean', describe: 'Use the previous build even if the app changed' })
      .option('force-build', { type: 'boolean', describe: 'Build even when nothing changed' })
      .option('cache-from', { type: 'string', describe: 'BuildKit cache to import for the image build, as for docker buildx (repeatable)' })
      .option('cache-to', { type: 'string', describe: 'BuildKit cache to export after the image build, as for docker buildx (repeatable)' }),
  ).conflicts('cached-build', 'force-build');

/**
 * A string option given once, several times or not at all, as a list. Empty values (an unset
 * variable in a CI script: `--cache-from "$CACHE"`) are dropped, so the build runs without them.
 */
const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String).filter((s) => s.trim() !== '');

/** The pipeline options from the parsed deploy options. */
export function deployArgs(argv: Record<string, unknown>) {
  return {
    cachedBuild: !!argv['cached-build'],
    forceBuild: !!argv['force-build'],
    cacheFrom: list(argv['cache-from']),
    cacheTo: list(argv['cache-to']),
    ...rolloutArgs(argv),
  };
}

/**
 * Runs the deploy pipeline with the parsed options; `stopAfter` ends it after the build or
 * after the push. Throws a `CometError` that names every server that did not end healthy
 * (failed, reverted or skipped). An abort makes the pipeline itself throw, with exit code 130.
 */
async function runDeploy(ctx: CommandContext, argv: Record<string, unknown>, stopAfter?: 'build' | 'push'): Promise<void> {
  const outcome = await withAbortOnSignals(ctx.reporter, (signal) =>
    deployPipeline(
      ctx,
      { ...deployArgs(argv), stopAfter },
      { signal },
    ),
  );
  assertAllHealthy(`Deploy of ${outcome.version}`, outcome);
  if (!stopAfter) ctx.reporter.info(`\nDeployed ${outcome.version} to ${outcome.results.map((r) => r.server).join(', ')}.`);
}

/**
 * `deploy`. As in MUP, only the top-level command runs under the `default.deploy` key; the
 * pipeline adds `meteor.deploy` → `meteor.push` → `meteor.build`. The runner refuses a command
 * when the config has a hook on one of its keys (hooks are not supported yet).
 */
export const deployCommand: ConfigCommand = {
  command: 'deploy',
  describe: 'Build the app once locally and deploy it to the servers',
  builder: deployOptions,
  run: (ctx, argv) => ctx.runner.run('default.deploy', () => runDeploy(ctx, argv)),
};

/** `meteor deploy`: the same as `deploy`, without the `default.deploy` key. */
export const meteorDeployCommand: ConfigCommand = {
  command: 'deploy',
  describe: 'Same as "deploy"',
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv),
};

/**
 * `meteor push`: preflight, build, lock and distribute. The new version is on the
 * servers, but `:latest` and the running app do not change.
 */
export const meteorPushCommand: ConfigCommand = {
  command: 'push',
  describe: 'Build and upload the image to the servers, without activating it',
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'push'),
};

/**
 * `meteor build`: preflight and the local build only. It still connects to the servers,
 * because the preflight detects which platforms to build for.
 */
export const meteorBuildCommand: ConfigCommand = {
  command: 'build',
  describe: 'Build the app image locally only',
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'build'),
};
