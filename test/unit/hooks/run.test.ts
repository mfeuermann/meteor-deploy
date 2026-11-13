import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { createHookExecutor, hookServers, NODEMIRAL_STUB, runLocalCommand, runRemoteCommand } from '../../../src/hooks/run.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

/**
 * A context with three servers (only `a` runs the app); `remote` decides what each fake
 * connection answers, `unreachable` makes `ssh.get` fail for that server.
 */
async function setup(o: { servers?: string; remote?: (s: string, cmd: string, opts?: ExecOptions) => ExecResult; unreachable?: string } = {}) {
  const dir = tempDir({
    '.deploy/mup.js': `module.exports = {
      servers: { a: { host: '192.0.2.1', username: 'root', password: 'pw' }, b: { host: '192.0.2.2', username: 'root', password: 'pw' }, c: { host: '192.0.2.3', username: 'root', password: 'pw' } },
      app: { name: 'myapp', path: '../app', servers: { a: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
    };`,
    '.deploy/settings.json': '{}',
  });
  const out: string[] = [];
  const execs: string[] = [];
  const conn = (s: string) =>
    ({
      name: s,
      exec: async (cmd: string, opts?: ExecOptions) => {
        execs.push(`${s}: ${cmd}`);
        const r = o.remote?.(s, cmd, opts) ?? { code: 0, stdout: `hello from ${s}\n`, stderr: '' };
        if (r.stdout) opts?.onStdout?.(r.stdout);
        if (r.stderr) opts?.onStderr?.(r.stderr);
        return r;
      },
    }) as unknown as SshConnection;
  const ctx = await createContext(
    { config: '.deploy/mup.js', ...(o.servers ? { servers: o.servers } : {}) },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({
        get: async (s: string) => {
          if (s === o.unreachable) throw new Error('connect ECONNREFUSED');
          return conn(s);
        },
        closeAll: async () => {},
      }),
    },
  );
  return { ctx, dir, execs, out: () => out.join('') };
}

describe('localCommand', () => {
  it('runs a local command in the config directory and prints its output', async () => {
    const s = await setup();
    await runLocalCommand(s.ctx, 'pre.default.deploy', 'pwd; echo out; echo err >&2');
    const lines = s.out().split('\n');
    expect(realpathSync(lines[0])).toBe(realpathSync(join(s.dir, '.deploy')));
    expect(lines).toContain('out');
    expect(lines).toContain('err');
  });

  it('masks secrets in the hook output', async () => {
    const s = await setup();
    s.ctx.reporter.addSecrets(['s3cret-value']);
    await runLocalCommand(s.ctx, 'pre.default.deploy', 'echo s3cret-value');
    expect(s.out()).not.toContain('s3cret-value');
    expect(s.out()).toContain('***');
  });

  it('a failing local command fails with its exit code', async () => {
    const s = await setup();
    const run = runLocalCommand(s.ctx, 'pre.default.deploy', 'exit 3');
    await expect(run).rejects.toThrow(CometError);
    await expect(runLocalCommand(s.ctx, 'pre.default.deploy', 'exit 3')).rejects.toThrow('Hook "pre.default.deploy" failed: "exit 3" exited with code 3.');
  });
});

describe('remoteCommand', () => {
  it('hookServers are all servers of the config, filtered by --servers', async () => {
    expect(hookServers((await setup()).ctx)).toEqual(['a', 'b', 'c']);
    expect(hookServers((await setup({ servers: 'c a' })).ctx)).toEqual(['a', 'c']);
  });

  it('runs a remote command on every selected server and prints the output per host', async () => {
    const s = await setup({ servers: 'a c' });
    await runRemoteCommand(s.ctx, 'post.default.deploy', 'uptime');
    expect(s.execs.sort()).toEqual(['a: uptime', 'c: uptime']);
    expect(s.out()).toContain('=> output from 192.0.2.1\nhello from a\n');
    expect(s.out()).toContain('=> output from 192.0.2.3\nhello from c\n');
  });

  it('a remote command that fails only warns', async () => {
    const s = await setup({ remote: (srv) => (srv === 'b' ? { code: 3, stdout: '', stderr: 'nope\n' } : { code: 0, stdout: '', stderr: '' }), unreachable: 'c' });
    await runRemoteCommand(s.ctx, 'post.default.deploy', 'check');
    expect(s.out()).toContain('Warning: Hook "post.default.deploy": the remote command exited with code 3 on server "b".');
    expect(s.out()).toContain('Warning: Hook "post.default.deploy": the remote command could not run on server "c": connect ECONNREFUSED');
    expect(s.out()).toContain('nope');
  });
});

describe('the hook executor', () => {
  it('runs localCommand, method and remoteCommand in that order', async () => {
    const s = await setup({ servers: 'a' });
    const order: string[] = [];
    const api = { marker: 1 };
    const exec = createHookExecutor(s.ctx, () => api);
    await exec('pre.default.deploy', {
      localCommand: 'echo local',
      remoteCommand: 'echo remote',
      method: (a: unknown, n: unknown) => {
        order.push(`method ${(a as typeof api).marker} ${n === NODEMIRAL_STUB}`);
      },
    });
    const out = s.out();
    expect(out.indexOf('> Running hook pre.default.deploy "echo local"')).toBeLessThan(out.indexOf('local\n'));
    expect(out.indexOf('local\n')).toBeLessThan(out.indexOf('> Running hook pre.default.deploy remote command "echo remote"'));
    expect(order).toEqual(['method 1 true']);
    expect(s.execs).toEqual(['a: echo remote']);
  });

  it('a throwing method fails the hook with its message', async () => {
    const s = await setup();
    const exec = createHookExecutor(s.ctx, () => ({}));
    await expect(
      exec('post.meteor.start', {
        method: async () => {
          throw new Error('notify failed');
        },
      }),
    ).rejects.toThrow('Hook "post.meteor.start" failed: notify failed');
  });

  it('a failing localCommand stops the rest of the hook', async () => {
    const s = await setup();
    let called = false;
    const exec = createHookExecutor(s.ctx, () => ({}));
    await expect(exec('pre.default.deploy', { localCommand: 'exit 1', method: () => void (called = true) })).rejects.toThrow('exited with code 1');
    expect(called).toBe(false);
  });

  it('nodemiral throws on use', () => {
    expect(() => (NODEMIRAL_STUB as Record<string, unknown>).session).toThrow('nodemiral is not available in comet-deploy. Use api.runSSHCommand(server, command) instead.');
    expect(String(Object.prototype.toString.call(NODEMIRAL_STUB))).toBe('[object Object]');
    expect((NODEMIRAL_STUB as { then?: unknown }).then).toBeUndefined();
  });
});
