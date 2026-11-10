import type { Strategy } from '../../config/types.js';
import { CometError } from '../../core/errors.js';
import { rollbackPipeline } from '../../deploy/pipeline.js';
import type { ConfigCommand } from '../registry.js';
import { withAbortOnSignals } from '../signals.js';

const STRATEGIES: Strategy[] = ['canary', 'rolling', 'parallel'];

export const rollbackCommand: ConfigCommand = {
  command: 'rollback',
  describe: 'Switch back to the previous (or a given) version kept on the servers; the config stays',
  builder: (y) =>
    y
      .option('to', { type: 'string', describe: 'Version to roll back to (see "comet-deploy history")' })
      .option('strategy', { type: 'string', choices: STRATEGIES, describe: 'Rollout strategy (default: cometDeploy.strategy)' })
      .option('force-unlock', { type: 'boolean', describe: 'Release an existing deploy lock first' }),
  async run(ctx, argv) {
    const o = { to: argv.to as string | undefined, strategy: argv.strategy as Strategy | undefined, forceUnlock: !!argv['force-unlock'] };
    const outcome = await withAbortOnSignals(ctx.reporter, (signal) => rollbackPipeline(ctx, o, { signal }));
    if (!outcome.ok) {
      const bad = [...outcome.results.filter((r) => r.status !== 'healthy').map((r) => r.server), ...outcome.skipped];
      throw new CometError(`Rollback did not complete on: ${bad.join(', ')}`);
    }
    ctx.reporter.info(`\nRolled back ${outcome.results.map((r) => r.server).join(', ')} to ${outcome.version}.`);
  },
};
