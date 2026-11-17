/**
 * What a proxy server serves for the app's domains (`proxy-served.sh`, proxy certificates spec
 * §4.1), and the check after `deploy`, `reconfig` and `proxy setup` that it is `proxy.ssl.crt`
 * (§4.3): polled, because nginx and the Let's Encrypt companion settle after the command's own
 * steps.
 */
import type { NormalizedConfig } from '../config/types.js';
import { cometScript } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { certSummary, describeServed, parseServedValue, type ServedState } from './certs.js';
import { proxyDomains } from './render.js';

/** One server: the state per domain, and the domains a running app container names in VIRTUAL_HOST / LETSENCRYPT_HOST. */
export interface ServedOnServer {
  domains: Record<string, ServedState>;
  vhost: string[];
  letsEncrypt: string[];
}

/** The clock of the check; tests pass a fake one. */
export interface CertWaitDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const REAL_CERT_WAIT: CertWaitDeps = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const FIX = 'Run "comet-deploy proxy setup"; "comet-deploy proxy status" shows what each proxy serves.';

/** Parses `proxy-served.sh` (also part of `proxy-status.sh`); the keys use each domain's index. */
export function parseServedOutput(stdout: string, domains: string[]): ServedOnServer {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  return {
    domains: Object.fromEntries(domains.map((d, i) => [d, parseServedValue(kv.get(`served.${i}`) ?? '-')])),
    vhost: domains.filter((_d, i) => kv.get(`vhost.${i}`)?.trim() === '1'),
    letsEncrypt: domains.filter((_d, i) => kv.get(`le.${i}`)?.trim() === '1'),
  };
}

/** Reads what one proxy server serves for the app's domains (one script run). */
export async function readServed(conn: SshConnection, c: NormalizedConfig): Promise<ServedOnServer> {
  const domains = proxyDomains(c);
  const script = await cometScript('proxy-served.sh', { appName: c.app.name, domains });
  return parseServedOutput((await conn.runScript(script)).stdout, domains);
}

const servesExpected = (s: ServedState | undefined, expected: string) => s?.kind === 'cert' && certSummary(s.pem).fingerprint === expected;

/** How long the check after a deploy, reconfig or proxy setup waits for the certificate. */
export const CERT_WAIT_MS = 30_000;

/**
 * Reads until every domain serves the certificate with fingerprint `expected`, every
 * `intervalMs` (2 s) for at most `timeoutMs` (30 s). Stops at once when the server cannot be
 * checked (no openssl, no HTTPS port), and when `aborted` says the command was aborted (then the
 * caller ignores the reading). `onWait` is called once, before the first wait. Returns the last
 * reading.
 */
export async function waitForCustomCert(
  read: () => Promise<ServedOnServer>,
  expected: string,
  domains: string[],
  d: CertWaitDeps,
  o: { timeoutMs?: number; intervalMs?: number; onWait?: () => void; aborted?: () => boolean } = {},
): Promise<ServedOnServer> {
  const timeoutMs = o.timeoutMs ?? CERT_WAIT_MS;
  const intervalMs = o.intervalMs ?? 2_000;
  const start = d.now();
  let told = false;
  for (;;) {
    const last = await read();
    const states = domains.map((x) => last.domains[x]);
    if (states.some((s) => s?.kind === 'no-openssl' || s?.kind === 'no-https')) return last;
    if (states.every((s) => servesExpected(s, expected))) return last;
    if (d.now() - start >= timeoutMs || o.aborted?.()) return last;
    if (!told) {
      told = true;
      o.onWait?.();
    }
    await d.sleep(intervalMs);
    if (o.aborted?.()) return last;
  }
}

/**
 * The summary warnings for one proxy server after the check: a domain that does not get
 * proxy.ssl.crt, and, as in `status`, a proxy.ssl.crt that expires within 14 days, has expired or
 * is not for the domain. Empty when all is well.
 */
export function customCertWarnings(server: string, last: ServedOnServer, expected: string, domains: string[], now: Date): string[] {
  const states = domains.map((d) => [d, last.domains[d] ?? ({ kind: 'none' } as ServedState)] as const);
  if (states.some(([, s]) => s.kind === 'no-openssl')) return [`Could not check the certificate "${server}" serves: openssl is not installed on the server.`];
  if (states.some(([, s]) => s.kind === 'no-https')) return [`Could not check the certificate "${server}" serves: the proxy publishes no HTTPS port.`];
  const warnings: string[] = [];
  for (const [d, s] of states) {
    if (s.kind !== 'cert') {
      warnings.push(`"${server}" serves no certificate for ${d} (TLS handshake failed). ${FIX}`);
      continue;
    }
    const sum = certSummary(s.pem);
    if (sum.fingerprint !== expected) warnings.push(`"${server}" serves another certificate for ${d} than proxy.ssl.crt: ${sum.issuer}, expires ${sum.expires}. ${FIX}`);
    else warnings.push(...describeServed(server, d, s, { expected, now }).problems);
  }
  return warnings;
}
