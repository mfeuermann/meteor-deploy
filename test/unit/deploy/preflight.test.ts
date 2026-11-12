import { describe, expect, it } from 'vitest';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { CometError } from '../../../src/core/errors.js';
import { createContext } from '../../../src/core/context.js';
import { evaluatePreflight, platformForArch, runPreflight, type PreflightInput } from '../../../src/deploy/preflight.js';
import { createReporter } from '../../../src/output/reporter.js';
import { tempDir } from '../../helpers/fs.js';
import type { ServerFacts } from '../../../src/remote/ops.js';

const GiB = 1024 ** 3;
const facts = (f: Partial<ServerFacts> = {}): ServerFacts => ({
  arch: 'x86_64',
  dockerVersion: '27.3.1',
  dockerRunning: true,
  dockerRootFreeBytes: 50 * GiB,
  hasBash: true,
  sudo: 'ok',
  ...f,
});

function input(p: Partial<PreflightInput> = {}): PreflightInput {
  return {
    local: { docker: { ok: true, version: '27.0.0' }, platforms: ['linux/arm64', 'linux/amd64'], meteorOk: true },
    servers: { one: { facts: facts(), lock: null } },
    override: 'auto',
    needsBuild: true,
    checkLocks: true,
    distributes: true,
    ...p,
  };
}

describe('platformForArch', () => {
  it('maps uname -m values', () => {
    expect(platformForArch('x86_64')).toBe('linux/amd64');
    expect(platformForArch('amd64')).toBe('linux/amd64');
    expect(platformForArch('aarch64')).toBe('linux/arm64');
    expect(platformForArch('arm64')).toBe('linux/arm64');
    expect(() => platformForArch('armv7l')).toThrow(CometError);
  });
});

describe('evaluatePreflight', () => {
  it('passes a healthy setup', () => {
    const r = evaluatePreflight(input());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.platformByServer).toEqual({ one: 'linux/amd64' });
    expect(r.platforms).toEqual(['linux/amd64']);
  });

  it('reports an SSH error with the server name', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts() }, two: { error: 'connect ECONNREFUSED' } } }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/"two"/);
    expect(r.errors[0]).toMatch(/ECONNREFUSED/);
  });

  it('requires a running Docker and points to setup', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts({ dockerRunning: false, dockerVersion: null }) } } }));
    expect(r.errors.join('\n')).toMatch(/comet-deploy setup/);
  });

  it('rejects Docker older than 18', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts({ dockerVersion: '17.12.0' }) } } }));
    expect(r.errors.join('\n')).toMatch(/17\.12\.0/);
  });

  it('warns about less than 5 GiB free', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts({ dockerRootFreeBytes: 3 * GiB }) } } }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/3\.0 GiB/);
  });

  it('fails on a held lock with the holder and the unlock command', () => {
    const lock = { user: 'alice', machine: 'laptop', pid: 7, startedAt: '2026-11-07T18:30:05.000Z', command: 'deploy', tool: 'comet-deploy@0.1.0' };
    const r = evaluatePreflight(input({ servers: { one: { facts: facts(), lock } } }));
    expect(r.errors.join('\n')).toMatch(/alice/);
    expect(r.errors.join('\n')).toMatch(/comet-deploy unlock/);
    expect(evaluatePreflight(input({ checkLocks: false, servers: { one: { facts: facts(), lock } } })).errors).toEqual([]);
  });

  it('needs local Docker only when building', () => {
    const local = { docker: { ok: false, error: 'Cannot connect to the Docker daemon' }, platforms: [], meteorOk: false };
    expect(evaluatePreflight(input({ local })).errors.join('\n')).toMatch(/Docker daemon/);
    expect(evaluatePreflight(input({ local, needsBuild: false })).errors).toEqual([]);
  });

  it('requires buildx support for the target platform with an emulation hint', () => {
    const r = evaluatePreflight(input({ local: { docker: { ok: true }, platforms: ['linux/arm64'], meteorOk: true } }));
    expect(r.errors.join('\n')).toMatch(/linux\/amd64/);
    expect(r.errors.join('\n')).toMatch(/emulation/i);
  });

  it('lets the platform override win over uname', () => {
    const r = evaluatePreflight(input({ override: 'linux/arm64' }));
    expect(r.platformByServer).toEqual({ one: 'linux/arm64' });
  });

  it('lists unique platforms', () => {
    const r = evaluatePreflight(
      input({ servers: { one: { facts: facts() }, two: { facts: facts({ arch: 'amd64' }) }, three: { facts: facts({ arch: 'aarch64' }) } } }),
    );
    expect(r.platforms).toEqual(['linux/amd64', 'linux/arm64']);
  });

  it('requires bash on the server', () => {
    expect(evaluatePreflight(input({ servers: { one: { facts: facts({ hasBash: false }) } } })).errors.join('\n')).toMatch(/bash/);
  });

  it('says that sudo needs a password instead of "Docker is not running" (M13)', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts({ sudo: 'password', dockerRunning: false }) } } }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/sudo/);
    expect(r.errors[0]).toMatch(/password/);
    expect(r.errors[0]).toMatch(/NOPASSWD/);
    const m = evaluatePreflight(input({ servers: { one: { facts: facts({ sudo: 'missing', dockerRunning: false }) } } }));
    expect(m.errors).toEqual([expect.stringMatching(/sudo is not installed/)]);
  });

  it('fails early when the server does not allow TCP forwarding (M3)', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts(), forwardingError: 'reverse port forwarding is disabled' } } }));
    expect(r.errors).toEqual([expect.stringMatching(/"one".*forwarding.*AllowTcpForwarding yes/s)]);
  });

  it('says that the app was not set up instead of failing later at the lock', () => {
    const r = evaluatePreflight(input({ servers: { one: { facts: facts({ appSetup: false }) } } }));
    expect(r.errors).toEqual([expect.stringMatching(/"one".*not set up.*comet-deploy setup/)]);
    // `meteor build` does not touch the servers' app directory
    expect(evaluatePreflight(input({ distributes: false, servers: { one: { facts: facts({ appSetup: false }) } } })).errors).toEqual([]);
  });

  it('says that buildx is missing instead of asking for emulation', () => {
    const local = { docker: { ok: true }, platforms: [], meteorOk: true };
    const r = evaluatePreflight(input({ local }));
    expect(r.errors).toEqual([expect.stringMatching(/buildx/)]);
    expect(r.errors.join('\n')).not.toMatch(/emulation/i);
  });

  it('names the configured Meteor executable when it is missing (M4)', () => {
    const local = { docker: { ok: true }, platforms: ['linux/amd64'], meteorOk: false, meteorExecutable: '/opt/meteor/bin/meteor' };
    expect(evaluatePreflight(input({ local })).errors.join('\n')).toMatch(/"\/opt\/meteor\/bin\/meteor"/);
  });
});

// runPreflight runs the real local checks (docker, docker buildx, the meteor command). Their
// first run on a fresh CI machine took 3 to 5 s, more than vitest's default 5 s limit allows for.
const LOCAL_CHECKS_TIMEOUT = 30_000;

describe('runPreflight', () => {
  it('checks buildOptions.executable instead of always "meteor" (M4)', async () => {
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = { servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } }, app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' }, buildOptions: { executable: 'comet-test-no-such-meteor' } } };`,
    });
    const ctx = await createContext({ config: '.deploy/mup.js' }, { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
    await expect(runPreflight(ctx, [], { needsBuild: true, checkLocks: false, distributes: true })).rejects.toThrow(/"comet-test-no-such-meteor"/);
  }, LOCAL_CHECKS_TIMEOUT);

  it('runs a relative buildOptions.executable from the app directory, as the build does', async () => {
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = { servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } }, app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' }, buildOptions: { executable: './tools/meteor' } } };`,
      'app/tools/meteor': '#!/bin/sh\necho "Meteor 3.0"\n',
    });
    chmodSync(join(dir, 'app/tools/meteor'), 0o755);
    const ctx = await createContext({ config: '.deploy/mup.js' }, { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
    const err = await runPreflight(ctx, [], { needsBuild: true, checkLocks: false, distributes: true }).catch((e: Error) => e);
    expect(String(err instanceof Error ? err.message : '')).not.toMatch(/tools\/meteor/);
  }, LOCAL_CHECKS_TIMEOUT);
});

describe('evaluatePreflight: proxy servers', () => {
  it('requires a running proxy on every proxy server', () => {
    const r = evaluatePreflight(input({ proxyServers: { one: { proxyRunning: false } } }));
    expect(r.errors).toEqual([
      'Server "one": the reverse proxy is not set up (container mup-nginx-proxy is missing or stopped). Run "comet-deploy proxy setup" first.',
    ]);
    expect(evaluatePreflight(input({ proxyServers: { one: { proxyRunning: true } } })).errors).toEqual([]);
  });

  it('reports a proxy server that cannot be reached once', () => {
    expect(evaluatePreflight(input({ proxyServers: { edge: { error: 'connect ETIMEDOUT' } } })).errors).toEqual(['Server "edge": connect ETIMEDOUT']);
    const both = evaluatePreflight(input({ servers: { one: { error: 'connect ETIMEDOUT' } }, proxyServers: { one: { error: 'connect ETIMEDOUT' } } }));
    expect(both.errors).toEqual(['Server "one": connect ETIMEDOUT']);
  });
});
