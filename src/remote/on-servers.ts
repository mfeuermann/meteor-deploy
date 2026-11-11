/**
 * Fan-out helper for the simple commands that run the same step on several servers (`setup`
 * and the `docker` commands): runs the step everywhere at once, reports each server's
 * progress and turns the individual failures into one error. The deploy pipeline has its own
 * strategies (canary, parallel) and does not use it.
 */
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import type { SshConnection } from '../ssh/connection.js';

/**
 * Runs `fn` on all `servers` in parallel, reporting each as `[server] step ✓/✗`. `fn` may
 * return a short detail that is shown next to the ✓. A server whose SSH connection cannot be
 * opened counts as failed like one whose `fn` threw. Never stops early: every server finishes
 * first, then one CometError lists every failed server with its message.
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
