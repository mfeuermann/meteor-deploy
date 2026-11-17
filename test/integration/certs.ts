/**
 * What the proxy on a fake server serves over HTTPS, for the integration tests of the reverse
 * proxy: self-signed certificates for `proxy.ssl.crt`, the fingerprint nginx serves for a domain,
 * and waits that fail with what nginx served instead, the files and the companion's log.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { FakeServer } from '../harness/fake-servers.js';
import { waitFor } from './helpers.js';

const PROXY = 'mup-nginx-proxy';

/** The SHA-256 fingerprint in openssl's `-fingerprint` output, as upper-case hex without separators. */
function fingerprint(opensslOutput: string): string {
  const m = /Fingerprint=([0-9A-Fa-f:]+)/.exec(opensslOutput);
  return (m?.[1] ?? '').replace(/:/g, '').toUpperCase();
}

/** The fingerprint of a local PEM certificate file. */
export const fileFingerprint = (path: string) => fingerprint(execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', path], { encoding: 'utf8' }));

/** The certificate helpers for one domain. */
export function certTools(domain: string) {
  /** The arguments of `openssl req` for a self-signed certificate for the domain (with `cn` as its CN), valid for a year: no expiry warning. */
  const selfSigned = (cn: string, key: string, crt: string) =>
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${domain}`, '-keyout', key, '-out', crt];

  /** A self-signed certificate for the domain written to `<dir>/bundle.crt` and `<dir>/private.key`; returns its fingerprint. */
  function makeCert(dir: string, cn: string): string {
    execFileSync('openssl', selfSigned(cn, join(dir, 'private.key'), join(dir, 'bundle.crt')), { stdio: 'ignore' });
    return fileFingerprint(join(dir, 'bundle.crt'));
  }

  /** The fingerprint of the certificate nginx serves for the domain on port 443 of the fake server. */
  async function servedFingerprint(s: FakeServer): Promise<string> {
    const r = await s.exec(`echo | openssl s_client -connect localhost:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -fingerprint -sha256`);
    return fingerprint(r.stdout);
  }

  /** The issuer of the certificate nginx serves for the domain (openssl's `issuer=` line), or ''. */
  async function servedIssuer(s: FakeServer): Promise<string> {
    const r = await s.exec(`echo | openssl s_client -connect localhost:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null`);
    return r.stdout.trim();
  }

  /** What the fake server shows about the certificates: what nginx serves, the files, the companion log. */
  async function certDiagnostics(s: FakeServer): Promise<string> {
    const served = await s.exec(
      `echo | openssl s_client -connect localhost:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -subject -issuer -fingerprint -sha256 2>/dev/null || echo 'no certificate'`,
    );
    const files = await s.exec(`sudo ls -l /opt/${PROXY}/certs /opt/${PROXY}/mounted-certs 2>&1`);
    const log = await s.exec(`docker logs --tail 40 ${PROXY}-letsencrypt 2>&1`);
    return [`[${s.name}] served: ${served.stdout.trim() || 'no certificate'}`, `files:\n${files.stdout.trim()}`, `companion log:\n${log.stdout.trim()}`].join('\n\n');
  }

  /** Waits until nginx serves the certificate with `fp` for the domain; fails with what it served instead. */
  async function expectServed(s: FakeServer, fp: string, timeoutMs = 30_000): Promise<void> {
    if (await waitFor(async () => (await servedFingerprint(s)) === fp, timeoutMs, 1000)) return;
    expect.fail(`the proxy on ${s.name} does not serve the certificate ${fp} for ${domain}\n\n${await certDiagnostics(s)}`);
  }

  /** Checks for `forMs` that nginx keeps serving the certificate with `fp`; fails at the first other one. */
  async function expectStaysServed(s: FakeServer, fp: string, forMs: number): Promise<void> {
    const end = Date.now() + forMs;
    while (Date.now() < end) {
      const now = await servedFingerprint(s);
      if (now !== fp) {
        expect.fail(`after ${Math.round((forMs - (end - Date.now())) / 1000)} s the proxy on ${s.name} serves ${now || 'no certificate'} instead of ${fp} for ${domain}\n\n${await certDiagnostics(s)}`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { selfSigned, makeCert, servedFingerprint, servedIssuer, certDiagnostics, expectServed, expectStaysServed };
}
