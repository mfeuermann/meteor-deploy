import { describe, expect, it } from 'vitest';
import { createReporter } from '../../../src/output/reporter.js';

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
    // eslint-disable-next-line no-control-regex
    expect(lines.join('')).not.toMatch(/\u001b\[/);
  });

  it('suppresses verbose lines unless verbose', () => {
    const { r, lines } = setup(false);
    r.verboseLine(null, 'hidden');
    expect(lines).toEqual([]);
  });
});
