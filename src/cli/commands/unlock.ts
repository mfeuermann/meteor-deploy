/**
 * `unlock`: releases a deploy lock that a killed deploy left on the app servers (a second
 * Ctrl+C, a crash, a lost connection), and says who held it.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { describeHolder } from '../../deploy/pipeline.js';
import { readLock, releaseLock } from '../../remote/ops.js';
import type { ConfigCommand } from '../registry.js';

/**
 * Prints the holder of the deploy lock on every app server and releases it.
 * The servers are handled in parallel; one that fails does not stop the others, and a single
 * `CometError` lists the failures at the end. It does not check whether a deploy is still
 * running. `d` replaces the lock operations in tests.
 */
export async function unlockAll(ctx: CommandContext, d = { readLock, releaseLock }): Promise<void> {
  const servers = ctx.appServers();
  const res = await Promise.allSettled(
    servers.map(async (s) => {
      const conn = await ctx.ssh.get(s);
      const holder = await d.readLock(conn, ctx.config.app.name);
      if (!holder) {
        ctx.reporter.server(s, 'unlock', 'skipped', 'not locked');
        return;
      }
      await d.releaseLock(conn, ctx.config.app.name);
      ctx.reporter.server(s, 'unlock', 'ok', `released (was held by ${describeHolder(holder)})`);
    }),
  );
  const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`${servers[i]}: ${(x.reason as Error)?.message ?? x.reason}`] : []));
  if (failed.length) throw new CometError(`Could not release the lock:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}

/** `unlock`, a comet-deploy command (MUP has no deploy lock). */
export const unlockCommand: ConfigCommand = {
  command: 'unlock',
  describe: 'Release a stale deploy lock (shows who held it)',
  run: (ctx) => unlockAll(ctx),
};
