import type { Reporter } from '../output/reporter.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * First Ctrl+C (or SIGTERM, e.g. a cancelled CI job) aborts gracefully: the
 * current step finishes, no further server is touched and the locks are
 * released. A second signal quits immediately.
 */
export function withAbortOnSignals<T>(reporter: Reporter, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onSignal = () => {
    if (ac.signal.aborted) process.exit(130);
    reporter.warn('Aborting after the current step… (press Ctrl+C again to quit immediately)');
    ac.abort();
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  return fn(ac.signal).finally(() => {
    for (const s of SIGNALS) process.off(s, onSignal);
  });
}
