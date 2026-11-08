import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/main.js';
import { CometError } from '../../../src/core/errors.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

describe('main', () => {
  it('prints the package version for --version and exits 0', async () => {
    const c = capture();
    const code = await main(['--version'], c.io);
    expect(code).toBe(0);
    expect(c.out.join('')).toContain('0.1.0');
  });

  it('exits non-zero for an unknown command', async () => {
    const c = capture();
    const code = await main(['nonexistent-cmd'], c.io);
    expect(code).not.toBe(0);
  });
});

describe('CometError', () => {
  it('defaults exitCode to 1 and keeps hint', () => {
    const e = new CometError('boom', { hint: 'try again' });
    expect(e.exitCode).toBe(1);
    expect(e.hint).toBe('try again');
    expect(e).toBeInstanceOf(Error);
  });
});
