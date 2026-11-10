import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';

/**
 * Runs `fn` on all `servers` in parallel, reporting each as `[server] step ✓/✗`.
 * Throws one CometError listing every failed server after all have finished.
 */
export async function runOnServers(
  ctx: CommandContext,
  servers: string[],
  step: string,
  fn: (conn: SshConnection, server: string) => Promise<string | void>,
): Promise<void> {
  const res = await Promise.allSettled(
    servers.map(async (s) => {
      ctx.reporter.server(s, step, 'running');
      try {
        const detail = await fn(await ctx.ssh.get(s), s);
        ctx.reporter.server(s, step, 'ok', detail || undefined);
      } catch (err) {
        ctx.reporter.server(s, step, 'failed', (err as Error)?.message ?? String(err));
        throw err;
      }
    }),
  );
  const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`${servers[i]}: ${(x.reason as Error)?.message ?? x.reason}`] : []));
  if (failed.length) throw new CometError(`${step} failed on ${failed.length} server(s):\n${failed.map((f) => `  - ${f}`).join('\n')}`);
}
