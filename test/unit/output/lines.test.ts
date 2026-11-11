import { describe, expect, it } from 'vitest';
import { lineSplitter, verboseOutput } from '../../../src/output/lines.js';
import type { Reporter } from '../../../src/output/reporter.js';

describe('lineSplitter', () => {
  it('joins chunks into lines and flushes a last line without a newline', () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push('one\ntw');
    s.push('o\nthr');
    expect(lines).toEqual(['one', 'two']);
    s.flush();
    s.flush();
    expect(lines).toEqual(['one', 'two', 'thr']);
  });
});

describe('verboseOutput', () => {
  it('prints the last line of each stream when the command ends', () => {
    const lines: string[] = [];
    const reporter = { verbose: true, verboseLine: (_s: string | null, l: string) => void lines.push(l) } as unknown as Reporter;
    const o = verboseOutput(reporter, 'one');
    o.onStdout!('out 1\nout 2');
    o.onStderr!('err 1');
    o.onClose!();
    expect(lines).toEqual(['out 1', 'out 2', 'err 1']);
  });
});
