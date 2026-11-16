import { describe, expect, it } from 'vitest';
import { debugSignalHandler } from '../../../src/cli/commands/debug.js';
import { createReporter } from '../../../src/output/reporter.js';

describe('meteor debug signals', () => {
  it('the first Ctrl+C stops and cleans up, a second one quits at once', () => {
    const out: string[] = [];
    const exits: number[] = [];
    const ac = new AbortController();
    const onSignal = debugSignalHandler(ac, createReporter({ verbose: false, tty: false, write: (s) => out.push(s) }), (code) => exits.push(code));
    onSignal();
    expect(ac.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    expect(out.join('')).toContain('Stopping the debugger… (press Ctrl+C again to quit immediately)');
    // A cleanup that hangs (a dropped connection) no longer keeps the user waiting.
    onSignal();
    expect(exits).toEqual([130]);
    expect(out.join('')).toContain('the next "comet-deploy meteor debug" removes the helper container');
  });
});
