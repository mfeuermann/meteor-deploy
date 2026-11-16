import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runSsh } from '../../../src/cli/commands/ssh.js';
import { main } from '../../../src/cli/main.js';
import { createContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import type { LocalTerminal } from '../../../src/ssh/interactive.js';

// Two servers, "one" and "two".
const fixture = join(import.meta.dirname, '../../fixtures/configs/per-server-env');

function fakeConn(calls: { server: string; command: string | null }[], exitCode: number) {
  return (name: string) =>
    ({
      name,
      interactive: async (command: string) => (calls.push({ server: name, command }), exitCode),
      shell: async () => (calls.push({ server: name, command: null }), exitCode),
    }) as unknown as SshConnection;
}

async function context(o: { servers?: string; exitCode?: number } = {}) {
  const calls: { server: string; command: string | null }[] = [];
  const conn = fakeConn(calls, o.exitCode ?? 0);
  const ctx = await createContext(
    { config: join(fixture, 'mup.js'), servers: o.servers },
    {
      cwd: fixture,
      reporter: createReporter({ verbose: false, tty: false, write: () => {} }),
      sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    },
  );
  const out = Object.assign(new EventEmitter(), { write: () => true });
  const term = { stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: out, stderr: out } as unknown as LocalTerminal;
  return { calls, ctx, term };
}

/** Runs the CLI in-process with the fake pool; returns the exit code and the commands sent. */
async function cli(args: string[], exitCode = 0) {
  const calls: { server: string; command: string | null }[] = [];
  const conn = fakeConn(calls, exitCode);
  const err: string[] = [];
  const code = await main(['--config', join(fixture, 'mup.js'), ...args], { stdout: () => {}, stderr: (s) => err.push(s) }, {
    cwd: fixture,
    sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
  });
  return { code, calls, err: err.join('') };
}

describe('ssh', () => {
  it('no command opens a shell', async () => {
    const r = await context();
    await runSsh(r.ctx, ['two'], r.term);
    expect(r.calls).toEqual([{ server: 'two', command: null }]);
    expect(r.ctx.runner.history).toEqual(['default.ssh']);
  });

  it('runs the joined command and passes its exit code', async () => {
    const r = await cli(['ssh', 'one', '--', 'docker', 'ps'], 4);
    expect(r.calls).toEqual([{ server: 'one', command: 'docker ps' }]);
    expect(r.code).toBe(4);
    expect(r.err).toContain('"docker ps" exited with code 4 on "one".');
  });

  it('passes option-like words after -- through', async () => {
    const r = await cli(['ssh', 'one', '--', 'docker', 'ps', '-a', '--no-trunc']);
    expect(r.calls).toEqual([{ server: 'one', command: 'docker ps -a --no-trunc' }]);
    expect(r.code).toBe(0);
  });

  it('--servers one with a bare command', async () => {
    const r = await cli(['ssh', '--servers', 'one', '--', 'uptime']);
    expect(r.calls).toEqual([{ server: 'one', command: 'uptime' }]);
  });

  it('candidates are all servers of the config, filtered by --servers', async () => {
    const two = await cli(['ssh']);
    expect(two.code).toBe(1);
    expect(two.err).toContain('Choose a server: comet-deploy ssh <server>. Servers: one, two');
    const r = await context({ servers: 'two' });
    await runSsh(r.ctx, [], r.term);
    expect(r.calls).toEqual([{ server: 'two', command: null }]);
  });

  it('a shell that exits non-zero ends with its code', async () => {
    const r = await context({ exitCode: 3 });
    await expect(runSsh(r.ctx, ['one'], r.term)).rejects.toMatchObject({ exitCode: 3, message: 'The shell on "one" exited with code 3.' });
  });
});
