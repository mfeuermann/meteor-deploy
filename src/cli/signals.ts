/**
 * Graceful abort for the rollout commands (deploy, reconfig, restart, rollback and their
 * `meteor …` variants): the first SIGINT/SIGTERM becomes an `AbortSignal` that the pipeline
 * checks between steps, so it never stops a server halfway through an activation.
 */
import { CometError } from '../core/errors.js';
import type { Reporter } from '../output/reporter.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * First Ctrl+C (or SIGTERM, e.g. a cancelled CI job) aborts gracefully: the
 * current step finishes, no further server is touched and the locks are
 * released. A second signal quits immediately.
 *
 * `fn` receives the signal and decides what "abort" means; the handlers are removed when it
 * settles, so later signals get Node's default behavior again.
 */
export function withAbortOnSignals<T>(reporter: Reporter, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  // Having a SIGINT/SIGTERM listener replaces Node's default (exit at once); that is what
  // lets the current step finish after the first signal.
  const onSignal = () => {
    // Second signal: exit now with 130 (128 + SIGINT), the code a graceful abort ends with
    // too. Locks can stay on the servers; `comet-deploy unlock` releases them.
    if (ac.signal.aborted) process.exit(130);
    reporter.warn('Aborting after the current step… (press Ctrl+C again to quit immediately)');
    ac.abort();
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  return fn(ac.signal)
    .catch((e: unknown) => {
      // After the signal the command ends with 130 whatever stopped it, e.g. a hook's local
      // command that died of the same Ctrl+C and failed its step.
      if (ac.signal.aborted && e instanceof CometError && e.exitCode !== 130) {
        throw new CometError(e.message, { exitCode: 130, hint: e.hint, cause: e });
      }
      throw e;
    })
    .finally(() => {
      for (const s of SIGNALS) process.off(s, onSignal);
    });
}
