/**
 * `deploy` and its hidden MUP variants: `meteor deploy` (the same), `meteor push` (stops after
 * the image is on the servers, without activating it) and `meteor build` (stops after the
 * local build). All of them run the deploy pipeline with Ctrl+C turned into a graceful abort.
 */
import type { Argv } from 'yargs';
import type { Strategy } from '../../config/types.js';
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { deployPipeline } from '../../deploy/pipeline.js';
import type { ConfigCommand } from '../registry.js';
import { withAbortOnSignals } from '../signals.js';

const STRATEGIES: Strategy[] = ['canary', 'rolling', 'parallel'];

/**
 * Options of all four deploy commands. In MUP they all accept `--cached-build`; the other
 * options are comet-deploy's own.
 */
const deployOptions = (y: Argv) =>
  y
    .option('cached-build', { type: 'boolean', describe: 'Use the previous build even if the app changed' })
    .option('force-build', { type: 'boolean', describe: 'Build even when nothing changed' })
    .option('strategy', { type: 'string', choices: STRATEGIES, describe: 'Rollout strategy (default: cometDeploy.strategy)' })
    .option('force-unlock', { type: 'boolean', describe: 'Release an existing deploy lock first' })
    .conflicts('cached-build', 'force-build');

/**
 * Runs the deploy pipeline with the parsed options; `stopAfter` ends it after the build or
 * after the push. Throws a `CometError` that names every server that did not end healthy
 * (failed, reverted or skipped). An abort makes the pipeline itself throw, with exit code 130.
 */
async function runDeploy(ctx: CommandContext, argv: Record<string, unknown>, stopAfter?: 'build' | 'push'): Promise<void> {
  const outcome = await withAbortOnSignals(ctx.reporter, (signal) =>
    deployPipeline(
      ctx,
      {
        cachedBuild: !!argv['cached-build'],
        forceBuild: !!argv['force-build'],
        strategy: argv.strategy as Strategy | undefined,
        stopAfter,
        forceUnlock: !!argv['force-unlock'],
      },
      { signal },
    ),
  );
  if (!outcome.ok) {
    const bad = [...outcome.results.filter((r) => r.status !== 'healthy').map((r) => r.server), ...outcome.skipped];
    throw new CometError(`Deploy of ${outcome.version} did not complete on: ${bad.join(', ')}`);
  }
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

/** Hidden `meteor deploy`: the same as `deploy`, without the `default.deploy` key. */
export const meteorDeployCommand: ConfigCommand = {
  command: 'deploy',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv),
};

/**
 * Hidden `meteor push`: preflight, build, lock and distribute. The new version is on the
 * servers, but `:latest` and the running app do not change.
 */
export const meteorPushCommand: ConfigCommand = {
  command: 'push',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'push'),
};

/**
 * Hidden `meteor build`: preflight and the local build only. It still connects to the servers,
 * because the preflight detects which platforms to build for.
 */
export const meteorBuildCommand: ConfigCommand = {
  command: 'build',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'build'),
};
