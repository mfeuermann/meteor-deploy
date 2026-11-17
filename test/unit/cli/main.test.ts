import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('the banner', () => {
  const terminal = { columns: 100 };

  it('deploy, meteor deploy and setup print it first in a terminal', async () => {
    const { tempDir } = await import('../../helpers/fs.js');
    const dir = tempDir();
    for (const cmd of [['deploy'], ['meteor', 'deploy'], ['setup']]) {
      const c = capture();
      await main(cmd, c.io, { cwd: dir, terminal });
      expect(c.out[0], cmd.join(' ')).toContain('by Marek Feuermann');
      expect(c.out[0], cmd.join(' ')).toContain(`v${VERSION}`);
    }
  });

  it('is colored only when the terminal has colors (NO_COLOR, TERM=dumb)', async () => {
    const { tempDir } = await import('../../helpers/fs.js');
    const dir = tempDir();
    for (const color of [true, false]) {
      const c = capture();
      await main(['deploy'], c.io, { cwd: dir, terminal: { columns: 100, color } });
      expect(c.out[0]!.includes('\x1b['), `color: ${color}`).toBe(color);
    }
  });

  it('other commands, --help and output that is no terminal have none', async () => {
    const { tempDir } = await import('../../helpers/fs.js');
    const dir = tempDir();
    const runs: Array<[string[], { terminal?: typeof terminal }]> = [
      [['status'], { terminal }],
      [['validate'], { terminal }],
      [['deploy', '--help'], { terminal }],
      [['deploy'], {}],
      [['setup'], {}],
    ];
    for (const [cmd, deps] of runs) {
      const c = capture();
      await main(cmd, c.io, { cwd: dir, ...deps });
      expect(c.out.join('') + c.err.join(''), cmd.join(' ')).not.toContain('Marek Feuermann');
    }
  });
});

describe('meteor debug', () => {
  it('is a real command that picks an app server first', async () => {
    const c = capture();
    const fixture = join(import.meta.dirname, '../../fixtures/configs/per-server-env');
    const code = await main(['--config', join(fixture, 'mup.js'), 'meteor', 'debug'], c.io, { cwd: fixture });
    expect(code).toBe(1);
    expect(c.err.join('')).toContain('Choose a server: comet-deploy meteor debug <server>. Servers: one, two');
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
