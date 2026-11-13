import { describe, expect, it } from 'vitest';
import type { NormalizedConfig, RegistryConfig } from '../../../src/config/types.js';
import type { RunResult } from '../../../src/local/exec.js';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import {
  assertRegistryPushable,
  isAuthError,
  pullFromRegistry,
  pushImage,
  registryLogin,
  registryOfHost,
  registryOfPrefix,
  registryRepo,
  usesRegistry,
} from '../../../src/transfer/registry.js';

const REG: RegistryConfig = { host: 'reg.example.com', imagePrefix: 'reg.example.com/team', username: 'u', password: 'registry-pw' };
const NO_CREDS: RegistryConfig = { host: 'reg.example.com', imagePrefix: 'reg.example.com/team' };

/** A fake local `run`: answers by the docker subcommand (`login`, `tag`, `push`, `rmi`). */
function fakeRun(answers: Partial<Record<string, Partial<RunResult>>> = {}) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run = (async (cmd: string, args: string[], o: { input?: string; onLine?: (l: string, s: 'stdout' | 'stderr') => void } = {}) => {
    calls.push({ cmd, args, input: o.input });
    const a = answers[args[0]] ?? {};
    for (const l of (a.stdout ?? '').split('\n').filter(Boolean)) o.onLine?.(l, 'stdout');
    return { code: 0, stdout: '', stderr: '', ...a };
  }) as unknown as typeof import('../../../src/local/exec.js').run;
  return { run, calls };
}

/** A fake SSH connection: `answer` maps a command to its result (default: success, no output). */
function fakeConn(answer: (cmd: string) => Partial<ExecResult> = () => ({})) {
  const commands: string[] = [];
  const conn = {
    name: 'one',
    host: '192.0.2.1',
    async exec(cmd: string, _o?: ExecOptions): Promise<ExecResult> {
      commands.push(cmd);
      return { code: 0, stdout: '', stderr: '', ...answer(cmd) };
    },
  } as unknown as SshConnection;
  return { conn, commands };
}

const config = (reg?: RegistryConfig) => ({ app: { name: 'MyApp' }, privateDockerRegistry: reg }) as unknown as NormalizedConfig;

describe('registry naming', () => {
  it.each([
    ['reg.example.com', 'reg.example.com'],
    ['https://REG.example.com/', 'reg.example.com'],
    ['reg.example.com:5000', 'reg.example.com:5000'],
    ['https://index.docker.io/v1/', 'docker.io'],
    ['registry-1.docker.io', 'docker.io'],
    ['docker.io', 'docker.io'],
  ])('registryOfHost(%s) = %s', (host, expected) => {
    expect(registryOfHost(host)).toBe(expected);
  });

  it.each([
    ['reg.example.com/team', 'reg.example.com'],
    ['127.0.0.1:5000/x', '127.0.0.1:5000'],
    ['localhost/x', 'localhost'],
    ['REG.example.com/team', 'reg.example.com'],
    ['myteam', 'docker.io'],
    ['myteam/sub', 'docker.io'],
  ])('registryOfPrefix(%s) = %s', (prefix, expected) => {
    expect(registryOfPrefix(prefix)).toBe(expected);
  });

  it('registryRepo is <imagePrefix>/mup-<lowercase app name>', () => {
    expect(registryRepo(config({ host: 'reg.example.com', imagePrefix: 'reg.example.com/team' }))).toBe('reg.example.com/team/mup-myapp');
  });

  it('usesRegistry follows privateDockerRegistry', () => {
    expect(usesRegistry(config({ host: 'reg.example.com' }))).toBe(true);
    expect(usesRegistry(config())).toBe(false);
  });
});

describe('assertRegistryPushable', () => {
  it.each([
    [{ host: 'reg.example.com', imagePrefix: 'reg.example.com/team' }],
    [{ host: 'https://reg.example.com/', imagePrefix: 'REG.example.com/team' }],
    [{ host: 'https://index.docker.io/v1/', imagePrefix: 'user' }],
    [{ host: 'docker.io', imagePrefix: 'user' }],
    [{ host: '127.0.0.1:5000', imagePrefix: '127.0.0.1:5000/comet' }],
  ])('accepts %j', (reg) => {
    expect(() => assertRegistryPushable(config(reg))).not.toThrow();
  });

  it('does nothing without a registry', () => {
    expect(() => assertRegistryPushable(config())).not.toThrow();
  });

  it('requires imagePrefix', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com' }))).toThrow(
      'privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".',
    );
  });

  it('refuses a prefix that would push to Docker Hub', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com', imagePrefix: 'myteam' }))).toThrow(
      'privateDockerRegistry.imagePrefix "myteam" would push to docker.io, not to the registry "reg.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "reg.example.com/myteam".',
    );
  });

  it('refuses a prefix on another port of the same host', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com', imagePrefix: 'reg.example.com:5000/t' }))).toThrow(
      'would push to reg.example.com:5000, not to the registry "reg.example.com"',
    );
  });
});

describe('registryLogin', () => {
  it('passes the password on stdin only', async () => {
    const f = fakeRun();
    expect(await registryLogin(REG, { run: f.run })).toBe(true);
    expect(f.calls).toEqual([{ cmd: 'docker', args: ['login', '--username', 'u', '--password-stdin', 'reg.example.com'], input: 'registry-pw' }]);
    expect(f.calls[0].args.join(' ')).not.toContain('registry-pw');
  });

  it('skips without both credentials', async () => {
    const f = fakeRun();
    expect(await registryLogin(NO_CREDS, { run: f.run })).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('fails with the registry and a hint, never with the password', async () => {
    const f = fakeRun({ login: { code: 1, stderr: 'Error response from daemon: Get "https://reg.example.com/v2/": unauthorized: registry-pw rejected' } });
    const err = await registryLogin(REG, { run: f.run }).catch((e) => e);
    expect(err.message).toMatch(/^Logging in to the registry "reg.example.com" failed: Error response from daemon/);
    expect(err.message).not.toContain('registry-pw');
    expect(err.hint).toBe('Check privateDockerRegistry.username and password. Nothing was built or pushed, and no server was changed.');
  });
});

describe('pushImage', () => {
  const ref = 'reg.example.com/team/mup-myapp:20261107-183005';
  const push = (f: ReturnType<typeof fakeRun>, reg = REG, onLine?: (l: string) => void) => pushImage({ localTag: 'mup-myapp:20261107-183005', ref, reg, run: f.run, onLine });

  it('tags, pushes and removes the tag', async () => {
    const lines: string[] = [];
    const f = fakeRun({ push: { stdout: 'abc: Pushed\n20261107-183005: digest: sha256:1 size: 1\n' } });
    await push(f, REG, (l) => lines.push(l));
    expect(f.calls.map((c) => c.args)).toEqual([
      ['tag', 'mup-myapp:20261107-183005', ref],
      ['push', ref],
      ['rmi', ref],
    ]);
    expect(lines).toContain('abc: Pushed');
  });

  it('removes the tag when the push fails', async () => {
    const f = fakeRun({ push: { code: 1, stderr: 'dial tcp: connection refused' } });
    await expect(push(f)).rejects.toThrow(`Pushing ${ref} to the registry failed: dial tcp: connection refused`);
    expect(f.calls.map((c) => c.args[0])).toEqual(['tag', 'push', 'rmi']);
  });

  it('hints at the account on an auth error', async () => {
    const f = fakeRun({ push: { code: 1, stderr: 'denied: requested access to the resource is denied' } });
    const err = await push(f).catch((e) => e);
    expect(err.hint).toBe('Check that the registry account may push to "reg.example.com/team". No server was changed.');
  });

  it('suggests docker login when the config has no credentials', async () => {
    const f = fakeRun({ push: { code: 1, stderr: 'unauthorized: authentication required' } });
    const err = await push(f, NO_CREDS).catch((e) => e);
    expect(err.hint).toBe('Check that the registry account may push to "reg.example.com/team". Or log in first with "docker login reg.example.com". No server was changed.');
  });

  it('hints at the connection on other errors', async () => {
    const f = fakeRun({ push: { code: 1, stderr: 'dial tcp: lookup reg.example.com: no such host' } });
    const err = await push(f).catch((e) => e);
    expect(err.hint).toBe('Check that this computer can reach the registry "reg.example.com". No server was changed.');
  });

  it('errors never contain the password', async () => {
    const f = fakeRun({ push: { code: 1, stderr: 'denied for u:registry-pw' } });
    const err = await push(f).catch((e) => e);
    expect(err.message).not.toContain('registry-pw');
  });

  it('a failed tag is reported without a push', async () => {
    const f = fakeRun({ tag: { code: 1, stderr: 'No such image: mup-myapp:20261107-183005' } });
    await expect(push(f)).rejects.toThrow('No such image');
    expect(f.calls.map((c) => c.args[0])).not.toContain('push');
  });
});

describe('isAuthError', () => {
  it.each(['denied: requested access', 'unauthorized: authentication required', 'no basic auth credentials', 'pull access DENIED'])('%s', (s) => {
    expect(isAuthError(s)).toBe(true);
  });
  it('connection errors are not auth errors', () => {
    expect(isAuthError('dial tcp: connection refused')).toBe(false);
  });
});

describe('pullFromRegistry', () => {
  const ref = 'reg.example.com/team/mup-myapp:20261107-183005';
  const target = 'mup-myapp:20261107-183005';

  it('pulls, retags and removes the pulled tag', async () => {
    const f = fakeConn();
    await pullFromRegistry(f.conn, { ref, targetTag: target, reg: REG });
    expect(f.commands[0]).toBe(`sudo docker pull '${ref}'`);
    expect(f.commands[1]).toBe(`sudo docker tag '${ref}' '${target}' && sudo docker rmi '${ref}'`);
    expect(f.commands[2]).toContain(`sudo docker image inspect '${target}'`);
  });

  it('adds the docker setup hint on an auth error', async () => {
    const f = fakeConn((c) => (c.includes('pull') ? { code: 1, stderr: 'Error response from daemon: unauthorized: authentication required' } : {}));
    const err = await pullFromRegistry(f.conn, { ref, targetTag: target, reg: REG }).catch((e) => e);
    expect(err.message).toMatch(new RegExp(`^\\[one\\] Pulling ${ref.replace(/[.]/g, '\\.')} failed \\(exit code 1\\):`));
    expect(err.message).toContain('The server is not logged in to the registry: run "comet-deploy docker setup", which runs docker login on the servers.');
  });

  it('without credentials the hint names docker login on the server', async () => {
    const f = fakeConn((c) => (c.includes('pull') ? { code: 1, stderr: 'no basic auth credentials' } : {}));
    const err = await pullFromRegistry(f.conn, { ref, targetTag: target, reg: NO_CREDS }).catch((e) => e);
    expect(err.message).toContain(
      'The server is not logged in to the registry: run "sudo docker login reg.example.com" on the server, or set privateDockerRegistry.username and password and run "comet-deploy docker setup".',
    );
  });

  it('other pull errors have no login hint', async () => {
    const f = fakeConn((c) => (c.includes('pull') ? { code: 1, stderr: 'manifest unknown' } : {}));
    const err = await pullFromRegistry(f.conn, { ref, targetTag: target, reg: REG }).catch((e) => e);
    expect(err.message).toContain('manifest unknown');
    expect(err.message).not.toContain('not logged in');
  });

  it('fails when tagging fails', async () => {
    const f = fakeConn((c) => (c.includes('docker tag') ? { code: 1, stderr: 'boom' } : {}));
    await expect(pullFromRegistry(f.conn, { ref, targetTag: target, reg: REG })).rejects.toThrow(`[one] Pulling ${ref} failed: tagging ${target} failed (exit code 1)`);
  });

  it('fails when the target tag is missing', async () => {
    const f = fakeConn((c) => (c.includes('image inspect') ? { code: 1 } : {}));
    await expect(pullFromRegistry(f.conn, { ref, targetTag: target, reg: REG })).rejects.toThrow(`[one] Pulling ${ref} failed: ${target} is missing on the server after docker pull.`);
  });
});
