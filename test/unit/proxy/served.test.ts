import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { certFingerprint, type ServedState } from '../../../src/proxy/certs.js';
import { customCertWarnings, parseServedOutput, waitForCustomCert, type ServedOnServer } from '../../../src/proxy/served.js';
import { cometScript } from '../../../src/remote/ops.js';

const certs = join(import.meta.dirname, '../../fixtures/certs');
const pem = (name: string) => readFileSync(join(certs, `${name}.pem`), 'utf8');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const cert = (name: string): ServedState => ({ kind: 'cert', pem: pem(name) });
const CUSTOM = certFingerprint(pem('custom'));
const TAIL = 'Run "comet-deploy proxy setup"; "comet-deploy proxy status" shows what each proxy serves.';

/**
 * Runs proxy-served.sh with bash against stub commands: `docker` answers for the app container
 * only, `openssl` serves a certificate for a.test and nothing for b.test, `sudo` and `timeout`
 * just run the command. Only the stubs and a few standard tools are on the PATH.
 */
const stubs = mkdtempSync(join(tmpdir(), 'comet-served-'));
afterAll(() => rmSync(stubs, { recursive: true, force: true }));
const binDirs = new Map<string, string>();
function runServed(script: string, o: { openssl?: boolean; port?: boolean } = {}): string {
  const key = `${o.openssl !== false}-${o.port !== false}`;
  if (!binDirs.has(key)) binDirs.set(key, makeBin(o));
  return execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: { PATH: binDirs.get(key)! } });
}
function makeBin(o: { openssl?: boolean; port?: boolean }): string {
  const dir = mkdtempSync(join(stubs, 'bin-'));
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  for (const t of ['sed', 'grep', 'tr', 'head', 'cat']) {
    symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), join(dir, t));
  }
  tool('sudo', 'exec "$@"');
  tool('timeout', 'shift; exec "$@"');
  tool('base64', `[ "$1" = -w0 ] && shift; ${execFileSync('/bin/sh', ['-c', 'command -v base64'], { encoding: 'utf8' }).trim()} "$@" | tr -d '\\n'`);
  tool(
    'docker',
    [
      `if [ "$1" = port ]; then ${o.port === false ? 'exit 1' : 'echo 0.0.0.0:8443'}; exit 0; fi`,
      'name="${@: -1}"',
      '[ "$name" = myapp ] || exit 1',
      'case "$3" in *State.Running*) echo true ;; *) printf "VIRTUAL_HOST=a.test,c.test\\nLETSENCRYPT_HOST=a.test\\nOTHER=b.test\\n" ;; esac',
    ].join('\n'),
  );
  if (o.openssl !== false) {
    tool(
      'openssl',
      [
        'while [ $# -gt 0 ]; do [ "$1" = -servername ] && d="$2"; [ "$1" = -connect ] && c="$2"; shift; done',
        '[ "$c" = 127.0.0.1:8443 ] || exit 1',
        'if [ "$d" = a.test ]; then printf "CONNECTED\\n-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----\\n---\\nmore\\n"; fi',
      ].join('\n'),
    );
  }
  return dir;
}

describe('proxy-served.sh', () => {
  const render = () => cometScript('proxy-served.sh', { appName: 'myapp', domains: ['a.test', 'b.test'] });

  it('asks nginx with SNI per domain, with a timeout, and never touches the key', async () => {
    const script = await render();
    expect(script).toContain('timeout 5 openssl s_client -connect 127.0.0.1:');
    expect(script.match(/-servername/g)).toHaveLength(2);
    expect(script).not.toContain('private.key');
  });

  it('prints the leaf certificate and which domains the app container names', async () => {
    const raw = runServed(await render());
    const out = parseServedOutput(raw, ['a.test', 'b.test']);
    expect(out.domains['a.test']).toEqual({ kind: 'none' }); // the stub's "AAAA" is no real certificate
    expect(out.domains['b.test']).toEqual({ kind: 'none' });
    expect(out.vhost).toEqual(['a.test']);
    expect(out.letsEncrypt).toEqual(['a.test']);
    expect(Buffer.from(/served\.0=(\S+)/.exec(raw)![1]!, 'base64').toString()).toBe('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
    expect(raw).toContain('served.1=-');
  });

  it('says so without openssl or without an HTTPS port', async () => {
    expect(runServed(await render(), { openssl: false })).toContain('served.0=noopenssl');
    expect(runServed(await render(), { port: false })).toContain('served.1=nohttps');
  });
});

describe('parseServedOutput', () => {
  it('reads the keys by domain index; missing keys mean no certificate and no container', () => {
    const out = parseServedOutput(`served.0=${b64(pem('custom'))}\nserved.1=-\nvhost.0=1\nvhost.1=0\nle.0=0\nle.1=1\n`, ['a.test', 'b.test']);
    expect(out).toEqual({ domains: { 'a.test': cert('custom'), 'b.test': { kind: 'none' } }, vhost: ['a.test'], letsEncrypt: ['b.test'] });
    expect(parseServedOutput('', ['a.test'])).toEqual({ domains: { 'a.test': { kind: 'none' } }, vhost: [], letsEncrypt: [] });
  });
});

describe('waitForCustomCert', () => {
  const reading = (state: ServedState): ServedOnServer => ({ domains: { 'a.test': state }, vhost: ['a.test'], letsEncrypt: [] });
  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return { sleeps, d: { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) } };
  }

  it('returns at once when the certificate is served, after the third read, or at the limit', async () => {
    const one = clock();
    let reads = 0;
    await waitForCustomCert(async () => (reads++, reading(cert('custom'))), CUSTOM, ['a.test'], one.d);
    expect([reads, one.sleeps]).toEqual([1, []]);

    const three = clock();
    reads = 0;
    await waitForCustomCert(async () => reading(++reads >= 3 ? cert('custom') : cert('le-leaf')), CUSTOM, ['a.test'], three.d);
    expect([reads, three.sleeps]).toEqual([3, [2000, 2000]]);

    const never = clock();
    reads = 0;
    const last = await waitForCustomCert(async () => (reads++, reading(cert('le-leaf'))), CUSTOM, ['a.test'], never.d);
    expect(reads).toBe(16);
    expect(never.sleeps.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(last).toEqual(reading(cert('le-leaf')));
  });

  it('says once that it waits, only when the first reading does not match, also when reading takes time', async () => {
    const waits: number[] = [];
    let reads = 0;
    // Like an SSH round trip: the clock moves while the proxy is read.
    const slow = clock();
    const read = async (pem: string) => {
      slow.d.sleep(300);
      return reading(cert(pem));
    };
    await waitForCustomCert(() => read(++reads >= 3 ? 'custom' : 'le-leaf'), CUSTOM, ['a.test'], slow.d, { onWait: () => waits.push(reads) });
    expect(waits).toEqual([1]);
    await waitForCustomCert(() => read('custom'), CUSTOM, ['a.test'], clock().d, { onWait: () => waits.push(-1) });
    expect(waits).toEqual([1]);
  });

  it('stops waiting when the command is aborted', async () => {
    const c = clock();
    let reads = 0;
    let aborted = false;
    const d = { now: c.d.now, sleep: async (ms: number) => void ((aborted = true), c.d.sleep(ms)) };
    await waitForCustomCert(async () => (reads++, reading(cert('le-leaf'))), CUSTOM, ['a.test'], d, { aborted: () => aborted });
    expect(reads).toBe(1);
  });

  it('does not wait when it cannot check', async () => {
    const c = clock();
    let reads = 0;
    await waitForCustomCert(async () => (reads++, reading({ kind: 'no-openssl' })), CUSTOM, ['a.test'], c.d);
    expect(reads).toBe(1);
  });
});

describe('customCertWarnings', () => {
  const now = new Date(Date.UTC(2125, 9, 1));
  const on = (domains: Record<string, ServedState>): ServedOnServer => ({ domains, vhost: Object.keys(domains), letsEncrypt: [] });

  it('is silent when every domain serves proxy.ssl.crt', () => {
    expect(customCertWarnings('one', on({ 'example.com': cert('custom'), 'www.example.com': cert('chain') }), CUSTOM, ['example.com', 'www.example.com'], now)).toEqual([]);
  });

  it('warns, like status, when the served proxy.ssl.crt expires soon or is not for the domain', () => {
    const soon = new Date(Date.UTC(2125, 11, 25));
    expect(customCertWarnings('one', on({ 'example.com': cert('custom') }), CUSTOM, ['example.com'], soon)).toEqual([
      '"one" serves a certificate for example.com that expires in 7 days (2126-01-01).',
    ]);
    expect(customCertWarnings('one', on({ 'a.test': cert('custom') }), CUSTOM, ['a.test'], now)).toEqual([
      '"one": proxy.ssl.crt is not for a.test (CN=example.com). Add the domain to the certificate, or remove it from proxy.domains.',
    ]);
  });

  it('names what is served instead, and how to fix it', () => {
    expect(customCertWarnings('one', on({ 'a.test': cert('le-leaf'), 'b.test': { kind: 'none' } }), CUSTOM, ['a.test', 'b.test'], now)).toEqual([
      `"one" serves another certificate for a.test than proxy.ssl.crt: Let's Encrypt (R11), expires 2126-01-01. ${TAIL}`,
      `"one" serves no certificate for b.test (TLS handshake failed). ${TAIL}`,
    ]);
  });

  it('warns once when it cannot check', () => {
    expect(customCertWarnings('one', on({ 'a.test': { kind: 'no-openssl' }, 'b.test': { kind: 'no-openssl' } }), CUSTOM, ['a.test', 'b.test'], now)).toEqual([
      'Could not check the certificate "one" serves: openssl is not installed on the server.',
    ]);
    expect(customCertWarnings('one', on({ 'a.test': { kind: 'no-https' } }), CUSTOM, ['a.test'], now)).toEqual([
      'Could not check the certificate "one" serves: the proxy publishes no HTTPS port.',
    ]);
  });
});
