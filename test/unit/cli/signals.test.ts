import { describe, expect, it } from 'vitest';
import { withAbortOnSignals } from '../../../src/cli/signals.js';
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
});
