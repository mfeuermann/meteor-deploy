import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStatusTable, parseStatus, parseStatusDetails } from '../../../src/cli/commands/status.js';
import { main } from '../../../src/cli/main.js';
import type { SshConnection } from '../../../src/ssh/connection.js';

const ID3 = 'sha256:3333';
const ID2 = 'sha256:2222';

describe('parseStatus', () => {
  it('reads a running app with a kept version, a lock and an HTTP answer', () => {
    const out = [
      'docker=27.5.1',
      'container=running',
      `image=20261103-100000 ${ID3}`,
      `image=20261102-100000 ${ID2}`,
      `image=latest ${ID3}`,
      `image=previous ${ID2}`,
      'lock={"user":"eve","machine":"box","pid":1,"startedAt":"2026-11-08T10:00:00.000Z","command":"deploy","tool":"t"}',
      'http=200',
    ].join('\n');
    expect(parseStatus(out)).toEqual({ docker: '27.5.1', container: 'running', version: '20261103-100000', lock: 'eve@box ("deploy" since 2026-11-08T10:00:00.000Z)', http: 200 });
  });

  it('handles a stopped / missing / restarting app, no lock and no answer', () => {
    expect(parseStatus('docker=27.5.1\ncontainer=exited\nhttp=000\n')).toEqual({ docker: '27.5.1', container: 'stopped', version: null, lock: null, http: null });
    expect(parseStatus('docker=27.5.1\ncontainer=missing\n').container).toBe('missing');
    expect(parseStatus('docker=27.5.1\ncontainer=restarting\n').container).toBe('restarting');
    expect(parseStatus('docker=not-installed\ncontainer=missing\n').docker).toBe('not-installed');
  });

  it('a :latest that is no kept version (deployed by MUP) has no version', () => {
    expect(parseStatus(`docker=27.5.1\ncontainer=running\nimage=latest sha256:mup\nimage=20261102-100000 ${ID2}\n`).version).toBeNull();
  });

  it('an unreadable lock still shows that the server is locked', () => {
    expect(parseStatus('docker=27.5.1\ncontainer=running\nlock=garbage\n').lock).toBe('held (owner unknown)');
  });
});

describe('formatStatusTable', () => {
  it('prints one row per server', () => {
    const t = formatStatusTable([
      { server: 'one', docker: '27.5.1', container: 'running', version: '20261103-100000', lock: null, http: 200 },
      { server: 'two', docker: 'not-running', container: 'missing', version: null, lock: 'eve@box', http: null },
    ]);
    const lines = t.split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['SERVER', 'DOCKER', 'APP', 'VERSION', 'HTTP', 'LOCK']);
    expect(lines[1]).toMatch(/^one\s+27\.5\.1\s+running\s+20261103-100000\s+200$/);
    expect(lines[2]).toMatch(/^two\s+not-running\s+missing\s+-\s+-\s+eve@box$/);
  });
});

describe('parseStatusDetails', () => {
  it('reads the details', () => {
    const out = [
      'os=Ubuntu 24.04.1 LTS',
      'arch=x86_64',
      'docker=27.5.1',
      `image=20261103-100000 ${ID3}`,
      `image=20261102-100000 ${ID2}`,
      `image=latest ${ID3}`,
      `image=previous ${ID2}`,
      'dockerroot=/var/lib/docker',
      'dockerfree=17773568',
      'container=running',
      'started=2026-11-16T08:12:00.123456789Z',
      'restarts=2',
      'port=127.0.0.1:3000 -> 3000/tcp',
      'port=0.0.0.0:3443 -> 443/tcp',
      'envname=MONGO_URL',
      'envname=PORT',
      'network=bridge',
      'httpurl=http://172.17.0.2:3000/',
      'http=200',
    ].join('\n');
    expect(parseStatusDetails(out)).toEqual({
      os: 'Ubuntu 24.04.1 LTS',
      arch: 'x86_64',
      dockerRoot: '/var/lib/docker',
      dockerFreeKb: 17773568,
      startedAt: '2026-11-16T08:12:00.123456789Z',
      restarts: 2,
      network: 'bridge',
      ports: ['127.0.0.1:3000 -> 3000/tcp', '0.0.0.0:3443 -> 443/tcp'],
      envNames: ['MONGO_URL', 'PORT'],
      previousVersion: '20261102-100000',
      httpUrl: 'http://172.17.0.2:3000/',
      foreignVersion: false,
    });
    expect(parseStatusDetails('container=missing\n')).toMatchObject({ os: null, dockerFreeKb: null, startedAt: null, restarts: null, network: null, ports: [], envNames: [], previousVersion: null, httpUrl: null, foreignVersion: false });
  });
});

// Two servers "one" (192.0.2.20) and "two" (192.0.2.21), both with ROOT_URL https://per-server.example.com.
const fixture = join(import.meta.dirname, '../../fixtures/configs/per-server-env');
const STDOUT: Record<string, string> = {
  one: [
    'os=Ubuntu 24.04.1 LTS',
    'arch=x86_64',
    'docker=27.5.1',
    'image=20261116-081100-1a2b3c4 sha256:aaa',
    'image=20261115-170200-9f8e7d6 sha256:bbb',
    'image=latest sha256:aaa',
    'image=previous sha256:bbb',
    'dockerroot=/var/lib/docker',
    'dockerfree=17773568',
    'container=running',
    'started=2026-11-16T08:12:00.123456789Z',
    'restarts=0',
    'port=127.0.0.1:4000 -> 3001/tcp',
    'envname=MONGO_URL',
    'envname=ROOT_URL',
    'network=bridge',
    'httpurl=http://172.17.0.2:3001/',
    'http=200',
    '',
  ].join('\n'),
  two: 'os=Debian GNU/Linux 12 (bookworm)\narch=aarch64\ndocker=26.1.4\ncontainer=restarting\nimage=latest sha256:mup\nrestarts=5\nnetwork=bridge\n',
};

async function runStatus(args: string[]) {
  const out: string[] = [];
  const checked: string[] = [];
  const conn = (n: string) => ({ name: n, runScript: async () => ({ code: 0, stdout: STDOUT[n], stderr: '' }) }) as unknown as SshConnection;
  const code = await main(['--config', join(fixture, 'mup.js'), ...args], { stdout: (s) => out.push(s), stderr: (s) => out.push(s) }, {
    cwd: fixture,
    sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    checkUrl: async (url: string) => (checked.push(url), '200'),
  });
  return { code, out: out.join(''), checked };
}

describe('status command', () => {
  it('--overview prints exactly the old output', async () => {
    // Taken from comet-deploy 0.5.0 `status` with the same answers of the servers (without the new keys).
    const r = await runStatus(['status', '--overview']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'SERVER  DOCKER  APP         VERSION                  HTTP  LOCK\none     27.5.1  running     20261116-081100-1a2b3c4  200\ntwo     26.1.4  restarting  -                        -\n',
    );
    expect(r.checked).toEqual([]);
  });

  it('status without --overview adds one section per server and the Docker warning', async () => {
    const r = await runStatus(['status']);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^SERVER\s+DOCKER/);
    expect(lines[3]).toBe('Warning: The servers run different Docker versions: 27.5.1 (one), 26.1.4 (two).');
    expect(r.out).toContain('== one (192.0.2.20)\nServer:     Ubuntu 24.04.1 LTS, x86_64, Docker 27.5.1, 18.2 GB free in /var/lib/docker\n');
    expect(r.out).toMatch(/Container: {2}running since \d{4}-\d\d-\d\d \d\d:\d\d \(.+\), restarted 0 times\n/);
    expect(r.out).toContain('Version:    20261116-081100-1a2b3c4 (:previous 20261115-170200-9f8e7d6)\n');
    expect(r.out).toContain('Env:        2 variables: MONGO_URL, ROOT_URL\n');
    expect(r.out).toContain('HTTP:       200 on the server (http://172.17.0.2:3001/), 200 from this computer (https://per-server.example.com/)\n');
    expect(r.out).toContain('== two (192.0.2.21)\nServer:     Debian GNU/Linux 12 (bookworm), aarch64, Docker 26.1.4\nContainer:  restarting, restarted 5 times\n');
    expect(r.out).toContain('Version:    not a comet-deploy version (MUP deployed it)\n');
    expect(r.out).toContain('Warning: The app container on "two" is restarting (restarted 5 times).');
    // Both servers have the same ROOT_URL: one check from here.
    expect(r.checked).toEqual(['https://per-server.example.com/']);
  });

  it('meteor status --overview is the table alone', async () => {
    const r = await runStatus(['meteor', 'status', '--overview']);
    expect(r.out.split('\n').filter(Boolean)).toHaveLength(3);
  });
});
