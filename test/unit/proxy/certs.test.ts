import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import { certFingerprint, describeServed, localCertFingerprint, parseServedValue, type ServedState } from '../../../src/proxy/certs.js';

const certs = join(import.meta.dirname, '../../fixtures/certs');
const configs = join(import.meta.dirname, '../../fixtures/configs');
const pem = (name: string) => readFileSync(join(certs, `${name}.pem`), 'utf8');
const served = (name: string): ServedState => ({ kind: 'cert', pem: pem(name) });

/** Every fixture is valid until 2126-01-01T00:00:00Z. */
const VALID_TO = Date.UTC(2126, 0, 1);
const daysBefore = (days: number, hours = 0) => new Date(VALID_TO - days * 86_400_000 - hours * 3_600_000);

function load(fixture: string, change?: (raw: Record<string, any>) => void) {
  const { raw, basePath } = loadConfig(join(configs, fixture), './mup.js');
  change?.(raw as Record<string, any>);
  return { c: normalizeConfig(raw, { basePath }), basePath };
}

describe('describeServed', () => {
  it("shows Let's Encrypt with the issuer, the date and the days left", () => {
    expect(describeServed('one', 'app.example.com', served('le-leaf'), { expected: null, now: daysBefore(76) })).toEqual({
      line: "app.example.com: Let's Encrypt (R11), expires 2126-01-01 (76 days)",
      problems: [],
    });
  });

  it('names proxy.ssl.crt when the fingerprint matches, and says when it does not', () => {
    const now = daysBefore(76);
    const own = describeServed('one', 'www.example.com', served('custom'), { expected: certFingerprint(pem('custom')), now });
    expect(own).toEqual({ line: 'www.example.com: proxy.ssl.crt, expires 2126-01-01 (76 days)', problems: [] });
    const other = describeServed('one', 'www.example.com', served('custom'), { expected: certFingerprint(pem('le-leaf')), now });
    expect(other.line).toBe('www.example.com: example.com, not the certificate from proxy.ssl.crt, expires 2126-01-01 (76 days)');
    expect(other.problems).toEqual(['"one" serves another certificate for www.example.com than proxy.ssl.crt: example.com, expires 2126-01-01.']);
  });

  it("flags a certificate that is not for the domain, such as the companion's default, and nothing else about it", () => {
    const d = describeServed('one', 'app.example.com', served('companion-default'), { expected: null, now: daysBefore(3) });
    expect(d.line).toContain(', not for app.example.com (CN=letsencrypt-nginx-proxy-companion)');
    expect(d.problems).toEqual(['"one" serves a certificate that is not for app.example.com: CN=letsencrypt-nginx-proxy-companion.']);
  });

  it('accepts a wildcard certificate for a subdomain', () => {
    const d = describeServed('one', 'shop.example.com', served('wildcard'), { expected: null, now: daysBefore(76) });
    expect(d.line).toBe('shop.example.com: *.example.com, expires 2126-01-01 (76 days)');
    expect(d.problems).toEqual([]);
  });

  it('warns from 14 days left, on the last day and after the expiry', () => {
    const at = (now: Date) => describeServed('one', 'app.example.com', served('le-leaf'), { expected: null, now });
    expect(at(daysBefore(15)).problems).toEqual([]);
    expect(at(daysBefore(14)).problems).toEqual(['"one" serves a certificate for app.example.com that expires in 14 days (2126-01-01).']);
    expect(at(daysBefore(1)).problems).toEqual(['"one" serves a certificate for app.example.com that expires in 1 day (2126-01-01).']);
    const today = at(daysBefore(0, 1));
    expect(today.line).toBe("app.example.com: Let's Encrypt (R11), expires 2126-01-01 (0 days)");
    expect(today.problems).toEqual(['"one" serves a certificate for app.example.com that expires in 0 days (2126-01-01).']);
    const expired = at(daysBefore(-3));
    expect(expired.line).toBe("app.example.com: Let's Encrypt (R11), expired on 2126-01-01");
    expect(expired.problems).toEqual(['"one" serves an expired certificate for app.example.com (expired on 2126-01-01).']);
  });

  it('describes a failed handshake, a server without openssl and a proxy without HTTPS', () => {
    const o = { expected: null, now: daysBefore(76) };
    expect(describeServed('one', 'app.example.com', { kind: 'none' }, o)).toEqual({
      line: 'app.example.com: no certificate (TLS handshake failed)',
      problems: ['"one" serves no certificate for app.example.com (TLS handshake failed).'],
    });
    expect(describeServed('one', 'app.example.com', { kind: 'no-openssl' }, o)).toEqual({
      line: 'app.example.com: cannot check: openssl is not installed on the server',
      problems: [],
    });
    expect(describeServed('one', 'app.example.com', { kind: 'no-https' }, o)).toEqual({ line: null, problems: [] });
  });
});

describe('parseServedValue', () => {
  it('reads the markers and a base64 certificate', () => {
    expect(parseServedValue('-')).toEqual({ kind: 'none' });
    expect(parseServedValue('noopenssl')).toEqual({ kind: 'no-openssl' });
    expect(parseServedValue('nohttps')).toEqual({ kind: 'no-https' });
    expect(parseServedValue(Buffer.from(pem('le-leaf')).toString('base64'))).toEqual({ kind: 'cert', pem: pem('le-leaf') });
    expect(parseServedValue(Buffer.from('not a cert').toString('base64'))).toEqual({ kind: 'none' });
  });
});

describe('certFingerprint', () => {
  it('is the fingerprint of the first certificate of a chain', () => {
    expect(certFingerprint(pem('chain'))).toBe(certFingerprint(pem('custom')));
    expect(certFingerprint(pem('custom'))).toMatch(/^[0-9A-F]{64}$/);
    expect(() => certFingerprint('no certificate here')).toThrow(/certificate/);
  });
});

describe('localCertFingerprint', () => {
  it('reads the first certificate of proxy.ssl.crt; null when it is missing, invalid or not used', () => {
    const chain = load('proxy-certs', (raw) => (raw.proxy.ssl.crt = join(certs, 'chain.pem')));
    expect(localCertFingerprint(chain.c, chain.basePath)).toBe(certFingerprint(pem('custom')));
    const invalid = load('proxy-certs');
    expect(localCertFingerprint(invalid.c, invalid.basePath)).toBeNull();
    const missing = load('proxy-certs', (raw) => (raw.proxy.ssl.crt = './missing.crt'));
    expect(localCertFingerprint(missing.c, missing.basePath)).toBeNull();
    const le = load('proxy-le');
    expect(localCertFingerprint(le.c, le.basePath)).toBeNull();
  });
});
