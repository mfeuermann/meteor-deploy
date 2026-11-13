import { describe, expect, it } from 'vitest';
import { withAbortOnSignals } from '../../../src/cli/signals.js';
import { CometError } from '../../../src/core/errors.js';
import { createReporter } from '../../../src/output/reporter.js';

describe('withAbortOnSignals', () => {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`${sig} aborts gracefully and the handler is removed afterwards`, async () => {
      const out: string[] = [];
      const reporter = createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) });
      const before = process.listenerCount(sig);
      const aborted = await withAbortOnSignals(reporter, async (signal) => {
        process.emit(sig);
        return signal.aborted;
      });
      expect(aborted).toBe(true);
      expect(out.join('')).toMatch(/Aborting/);
      expect(process.listenerCount(sig)).toBe(before);
    });
  }

  it('an error after the abort exits with 130, keeping its message', async () => {
    // A hook's local command dies of the same Ctrl+C and fails its step with exit code 1.
    const reporter = createReporter({ verbose: false, tty: false, write: () => {} });
    const run = withAbortOnSignals(reporter, async () => {
      process.emit('SIGINT');
      throw new CometError('Hook "pre.meteor.start" failed: "sleep 60" was stopped by SIGINT.');
    });
    await expect(run).rejects.toMatchObject({ exitCode: 130, message: 'Hook "pre.meteor.start" failed: "sleep 60" was stopped by SIGINT.' });
  });

  it('an error without an abort keeps its exit code', async () => {
    const reporter = createReporter({ verbose: false, tty: false, write: () => {} });
    await expect(withAbortOnSignals(reporter, async () => Promise.reject(new CometError('boom')))).rejects.toMatchObject({ exitCode: 1 });
  });
});
