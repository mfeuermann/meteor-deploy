import type { Argv } from 'yargs';
import type { Strategy } from '../../config/types.js';
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { deployPipeline } from '../../deploy/pipeline.js';
import type { ConfigCommand } from '../registry.js';

const STRATEGIES: Strategy[] = ['canary', 'rolling', 'parallel'];

const deployOptions = (y: Argv) =>
  y
    .option('cached-build', { type: 'boolean', describe: 'Use the previous build even if the app changed' })
    .option('force-build', { type: 'boolean', describe: 'Build even when nothing changed' })
    .option('strategy', { type: 'string', choices: STRATEGIES, describe: 'Rollout strategy (default: cometDeploy.strategy)' })
    .conflicts('cached-build', 'force-build');

/** First Ctrl+C aborts gracefully (locks released, nothing activated); the second quits. */
export function withAbortOnSigint<T>(ctx: CommandContext, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onSigint = () => {
    if (ac.signal.aborted) process.exit(130);
    ctx.reporter.warn('Aborting after the current step… (press Ctrl+C again to quit immediately)');
    ac.abort();
  };
  process.on('SIGINT', onSigint);
  return fn(ac.signal).finally(() => process.off('SIGINT', onSigint));
}

async function runDeploy(ctx: CommandContext, argv: Record<string, unknown>, stopAfter?: 'build' | 'push'): Promise<void> {
  const outcome = await withAbortOnSigint(ctx, (signal) =>
    deployPipeline(
      ctx,
      {
        cachedBuild: !!argv['cached-build'],
        forceBuild: !!argv['force-build'],
        strategy: argv.strategy as Strategy | undefined,
        stopAfter,
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

export const deployCommand: ConfigCommand = {
  command: 'deploy',
  describe: 'Build the app once locally and deploy it to the servers',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv),
};

export const meteorDeployCommand: ConfigCommand = {
  command: 'deploy',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv),
};

export const meteorPushCommand: ConfigCommand = {
  command: 'push',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'push'),
};

export const meteorBuildCommand: ConfigCommand = {
  command: 'build',
  describe: false,
  group: 'meteor',
  builder: deployOptions,
  run: (ctx, argv) => runDeploy(ctx, argv, 'build'),
};
