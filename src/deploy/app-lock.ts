/**
 * The app's deploy lock around a command that is not a rollout itself but changes something
 * every app server depends on: the shared proxy (proxy design §4.6) or the built-in MongoDB
 * (mongo design §4.6).
 */
import type { CommandContext } from '../core/context.js';
import { acquireLock, readLock, releaseLock } from '../remote/ops.js';
import { lockServers, releaseServers, type PipelineDeps } from './pipeline.js';

/** The lock functions these commands use (tests replace them). */
export type AppLockDeps = Pick<PipelineDeps, 'acquireLock' | 'releaseLock' | 'readLock'>;
export const APP_LOCK_DEPS: AppLockDeps = { acquireLock, releaseLock, readLock };

/**
 * Runs `fn` while holding the deploy lock of every app server, whatever `--servers` selects.
 * A server without the app directories (not set up yet) is skipped, so `setup` works on a new
 * server.
 */
export async function withAppLock<T>(ctx: CommandContext, command: string, d: AppLockDeps, fn: () => Promise<T>): Promise<T> {
  const locked = await lockServers(ctx, Object.keys(ctx.config.app.servers ?? {}), command, d, { skipNotSetUp: true });
  try {
    return await fn();
  } finally {
    await releaseServers(ctx, locked, d);
  }
}
