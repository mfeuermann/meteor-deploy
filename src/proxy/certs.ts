/**
 * The certificate a proxy server serves for one domain of the app (proxy certificates spec §4.1,
 * §4.2): what `proxy-served.sh` printed for it, described for `proxy status` and for the check
 * after a deploy. Pure functions; the certificate is parsed with `X509Certificate`.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { customCertFiles } from './render.js';

/** What a proxy server served for one domain: a leaf certificate, or why there is none. */
export type ServedState = { kind: 'cert'; pem: string } | { kind: 'none' } | { kind: 'no-openssl' } | { kind: 'no-https' };

/** The line of `proxy status` (null: nothing to show) and the warnings for one domain. */
export interface ServedLine {
  line: string | null;
  problems: string[];
}

/** Days left at which a certificate gets a warning: Let's Encrypt renews 30 days before. */
const WARN_DAYS = 14;
const DAY_MS = 86_400_000;
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One value of a `served.<i>=` line: `-`, `noopenssl`, `nohttps` or a base64 PEM certificate. */
export function parseServedValue(value: string): ServedState {
  const v = value.trim();
  if (v === 'noopenssl') return { kind: 'no-openssl' };
  if (v === 'nohttps') return { kind: 'no-https' };
  if (v === '' || v === '-') return { kind: 'none' };
  const pem = Buffer.from(v, 'base64').toString('utf8');
  const first = PEM_RE.exec(pem)?.[0];
  if (!first) return { kind: 'none' };
  try {
    new X509Certificate(first);
  } catch {
    return { kind: 'none' };
  }
  return { kind: 'cert', pem };
}

function firstCertificate(pem: string): X509Certificate {
  const first = PEM_RE.exec(pem)?.[0];
  if (!first) throw new CometError('No certificate found (expected a PEM "BEGIN CERTIFICATE" block).');
  return new X509Certificate(first);
}

/** The SHA-256 fingerprint of the first certificate in `pem`, upper-case hex without colons. */
export function certFingerprint(pem: string): string {
  return firstCertificate(pem).fingerprint256.replace(/:/g, '').toUpperCase();
}

/** The fingerprint of the first certificate in `proxy.ssl.crt`; null without one, or when it cannot be read or parsed. */
export function localCertFingerprint(c: NormalizedConfig, basePath: string): string | null {
  const files = customCertFiles(c, basePath);
  if (!files) return null;
  try {
    return certFingerprint(readFileSync(files.crt, 'utf8'));
  } catch {
    return null;
  }
}

/** `KEY=value` lines of an X509Certificate name (`issuer`, `subject`). */
function nameParts(name: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const line of name.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !parts.has(line.slice(0, eq))) parts.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return parts;
}

/** `O (CN)`, the CN or the O alone, or the whole name. */
function issuerLabel(cert: X509Certificate): string {
  const p = nameParts(cert.issuer);
  const o = p.get('O');
  const cn = p.get('CN');
  if (o && cn) return `${o} (${cn})`;
  return cn ?? o ?? cert.issuer.split('\n').join(', ');
}

/** `validTo` of an X509Certificate (`Jan  1 00:00:00 2126 GMT`) as a time. */
function validTo(cert: X509Certificate): number {
  const m = /^(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/.exec(cert.validTo);
  if (!m || !MONTHS.includes(m[1]!)) return Date.parse(cert.validTo);
  return Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]!), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The first certificate in `pem`: fingerprint (as `certFingerprint`), issuer label and expiry date (UTC `YYYY-MM-DD`). */
export function certSummary(pem: string): { fingerprint: string; issuer: string; expires: string } {
  const cert = firstCertificate(pem);
  return { fingerprint: cert.fingerprint256.replace(/:/g, '').toUpperCase(), issuer: issuerLabel(cert), expires: new Date(validTo(cert)).toISOString().slice(0, 10) };
}

/**
 * What `server` serves for `domain`, as a `proxy status` line plus warnings. `expected`: the
 * fingerprint of `proxy.ssl.crt` (null without a custom certificate, or when it cannot be read).
 * A certificate that is not for the domain gets only that warning.
 */
export function describeServed(server: string, domain: string, state: ServedState, o: { expected: string | null; now: Date }): ServedLine {
  if (state.kind === 'no-https') return { line: null, problems: [] };
  if (state.kind === 'no-openssl') return { line: `${domain}: cannot check: openssl is not installed on the server`, problems: [] };
  if (state.kind === 'none') {
    return { line: `${domain}: no certificate (TLS handshake failed)`, problems: [`"${server}" serves no certificate for ${domain} (TLS handshake failed).`] };
  }
  const cert = firstCertificate(state.pem);
  const fingerprint = cert.fingerprint256.replace(/:/g, '').toUpperCase();
  const own = o.expected !== null && fingerprint === o.expected;
  const label = own ? 'proxy.ssl.crt' : issuerLabel(cert);
  const subjectCn = nameParts(cert.subject).get('CN');
  const subject = subjectCn ? `CN=${subjectCn}` : cert.subject.split('\n').join(', ');
  const covers = cert.checkHost(domain) !== undefined;
  const end = validTo(cert);
  const date = new Date(end).toISOString().slice(0, 10);
  const days = Math.floor((end - o.now.getTime()) / DAY_MS);
  const expired = end <= o.now.getTime();

  const notes = [label];
  if (o.expected !== null && !own) notes.push('not the certificate from proxy.ssl.crt');
  if (!covers) notes.push(`not for ${domain} (${subject})`);
  notes.push(expired ? `expired on ${date}` : `expires ${date} (${plural(days)})`);
  const line = `${domain}: ${notes.join(', ')}`;

  if (!covers && own) {
    return { line, problems: [`"${server}": proxy.ssl.crt is not for ${domain} (${subject}). Add the domain to the certificate, or remove it from proxy.domains.`] };
  }
  if (!covers) return { line, problems: [`"${server}" serves a certificate that is not for ${domain}: ${subject}.`] };
  const problems: string[] = [];
  if (o.expected !== null && !own) problems.push(`"${server}" serves another certificate for ${domain} than proxy.ssl.crt: ${label}, expires ${date}.`);
  if (expired) problems.push(`"${server}" serves an expired certificate for ${domain} (expired on ${date}).`);
  else if (days <= WARN_DAYS) problems.push(`"${server}" serves a certificate for ${domain} that expires in ${plural(days)} (${date}).`);
  return { line, problems };
}
