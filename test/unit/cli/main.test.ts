import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/main.js';
import { CometError } from '../../../src/core/errors.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

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
    expect(c.out.join('').trim()).toBe(VERSION);
  });

  it('exits non-zero for an unknown command', async () => {
    const c = capture();
    const code = await main(['nonexistent-cmd'], c.io);
    expect(code).not.toBe(0);
  });
});

describe('phase-2 commands (M12)', () => {
  it('say they are planned for phase 2 instead of "unknown argument"', async () => {
    for (const args of [['ssh', 'one'], ['meteor', 'debug']]) {
      const c = capture();
      const code = await main(args, c.io);
      expect(code, args.join(' ')).toBe(1);
      expect(c.err.join(''), args.join(' ')).toMatch(/planned for phase 2/);
      // the command is quoted as typed
      expect(c.err.join(''), args.join(' ')).toContain(`"${args.join(' ')}"`);
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

describe('--show-hook-names', () => {
  it('prints the hook names and runs the command', async () => {
    const { main } = await import('../../../src/cli/main.js');
    const { captureIO, tempDir } = await import('../../helpers/fs.js');
    // A server that refuses the connection at once: status reports it and goes on.
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = {
        servers: { one: { host: '127.0.0.1', username: 'root', password: 'pw', opts: { port: 1 } } },
        app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
      };`,
    });
    const io = captureIO();
    await main(['status', '--show-hook-names', '--config', '.deploy/mup.js'], io.io, { cwd: dir });
    const hooks = io.all().split('\n').filter((l) => l.startsWith('Hook: '));
    expect(hooks).toEqual([
      'Hook: pre.default.status',
      'Hook: pre.docker.status',
      'Hook: post.docker.status',
      'Hook: pre.meteor.status',
      'Hook: post.meteor.status',
      'Hook: post.default.status',
    ]);
    expect(io.all()).toContain('Could not read the status of "one"');
  });
});
