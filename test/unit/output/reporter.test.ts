import { describe, expect, it } from 'vitest';
import { createReporter, formatDuration } from '../../../src/output/reporter.js';

function setup(verbose = false) {
  const lines: string[] = [];
  let t = 0;
  const r = createReporter({ verbose, tty: false, write: (s) => lines.push(s), now: () => t });
  return { r, lines, advance: (ms: number) => (t += ms) };
}

describe('reporter (plain mode)', () => {
  it('prints phase start and end with duration', async () => {
    const { r, lines, advance } = setup();
    const v = await r.phase('build', async () => {
      advance(1200);
      return 42;
    });
    expect(v).toBe(42);
    expect(lines[0]).toMatch(/^==> build/);
    expect(lines[1]).toMatch(/^<== build \(1\.2s\)/);
    expect(r.phaseTimings()).toEqual([{ name: 'build', durationMs: 1200 }]);
  });

  it('prints server step lines', () => {
    const { r, lines } = setup();
    r.server('one', 'distribute', 'ok', '4.2s');
    expect(lines[0]).toBe('[one] distribute ✓ 4.2s\n');
  });

  it('prints a summary table', () => {
    const { r, lines } = setup();
    r.summary([{ server: 'one', version: 'v1', result: 'ok', durationMs: 1500 }]);
    const out = lines.join('');
    expect(out).toMatch(/SERVER\s+VERSION\s+RESULT\s+TIME/);
    expect(out).toMatch(/one\s+v1\s+ok\s+1\.5s/);
  });

  it('masks registered secrets in every output', () => {
    const { r, lines } = setup(true);
    r.addSecrets(['s3cr3t-value']);
    r.info('connecting with s3cr3t-value');
    r.verboseLine('one', 'env s3cr3t-value');
    expect(lines.join('')).not.toContain('s3cr3t-value');
    expect(lines.join('')).toContain('***');
  });

  it('emits no ANSI escapes in plain mode', () => {
    const { r, lines } = setup();
    r.warn('careful');
    r.error('bad');
    r.server('one', 'start', 'failed');
    expect(lines.join('')).not.toMatch(/\u001b\[/);
  });

  it('hookName prints the line, colored only in a terminal', () => {
    const { r, lines } = setup();
    r.hookName('Hook: pre.default.deploy');
    expect(lines).toEqual(['Hook: pre.default.deploy\n']);
    const colored: string[] = [];
    createReporter({ verbose: false, tty: true, write: (s) => colored.push(s) }).hookName('Hook: post.meteor.start');
    expect(colored[0]).toContain('Hook: post.meteor.start');
  });

  it('suppresses verbose lines unless verbose', () => {
    const { r, lines } = setup(false);
    r.verboseLine(null, 'hidden');
    expect(lines).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('never prints 60 seconds inside a minute', () => {
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_960)).toBe('1m00s');
    expect(formatDuration(61_000)).toBe('1m01s');
    expect(formatDuration(119_600)).toBe('2m00s');
  });
});
