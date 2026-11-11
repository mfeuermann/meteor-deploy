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

describe('phase-2 commands (M12)', () => {
  it('say they are planned for phase 2 instead of "unknown argument"', async () => {
    for (const args of [['proxy', 'logs'], ['proxy'], ['mongo', 'start'], ['ssh', 'one'], ['meteor', 'debug']]) {
      const c = capture();
      const code = await main(args, c.io);
      expect(code, args.join(' ')).toBe(1);
      expect(c.err.join(''), args.join(' ')).toMatch(/planned for phase 2/);
    }
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

describe('--show-hook-names (I5)', () => {
  it('says hooks are phase 2 instead of silently doing nothing', async () => {
    const { main } = await import('../../../src/cli/main.js');
    const { captureIO } = await import('../../helpers/fs.js');
    const io = captureIO();
    expect(await main(['validate', '--show-hook-names'], io.io, { cwd: process.cwd() })).toBe(0);
    expect(io.stdout()).toMatch(/hooks.*phase 2/i);
  });
});
