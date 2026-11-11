/**
 * `rollback [--to <version>]`: switches the app servers back to an older image that is still
 * on them, by strategy and with a health check. Nothing is built or transferred, and only the
 * image changes: the current start.sh and env.list stay.
 */
import { rollbackPipeline } from '../../deploy/pipeline.js';
import type { ConfigCommand } from '../registry.js';
import { assertAllHealthy, rolloutArgs, rolloutOptions } from '../rollout.js';
import { withAbortOnSignals } from '../signals.js';

/**
 * `rollback`, a comet-deploy command (MUP has none). The pipeline runs it under the runner
 * key `default.rollback` and picks the target version per server. Throws a `CometError`
 * naming every server that did not end healthy; Ctrl+C aborts gracefully.
 */
export const rollbackCommand: ConfigCommand = {
  command: 'rollback',
  describe: 'Switch back to the previous (or a given) version kept on the servers; the config stays',
  builder: (y) => rolloutOptions(y.option('to', { type: 'string', describe: 'Version to roll back to (see "comet-deploy history")' })),
  async run(ctx, argv) {
    const o = { to: argv.to as string | undefined, ...rolloutArgs(argv) };
    const outcome = await withAbortOnSignals(ctx.reporter, (signal) => rollbackPipeline(ctx, o, { signal }));
    assertAllHealthy('Rollback', outcome);
    ctx.reporter.info(`\nRolled back ${outcome.results.map((r) => r.server).join(', ')} to ${outcome.version}.`);
  },
};
