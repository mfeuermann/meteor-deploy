import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { CometError } from '../../../src/core/errors.js';
import { proxyDomains, renderServiceConfigureSh } from '../../../src/proxy/render.js';
import {
  applyProxySync,
  desiredProxyFiles,
  planProxySync,
  readProxyFileState,
  regenerateNginx,
  serviceScriptContent,
  writeUpstreamFile,
  type DesiredProxyFiles,
  type ProxyFileState,
} from '../../../src/proxy/sync.js';
import { desiredEntries, formatUpstream } from '../../../src/proxy/upstream.js';
import type { ExecOptions, SshConnection } from '../../../src/ssh/connection.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function load(name: string, edit: (raw: any) => void = () => {}): { c: NormalizedConfig; dir: string } {
  const dir = join(fixtures, name);
  const { raw, basePath } = loadConfig(dir, './mup.js');
  edit(raw);
  return { c: normalizeConfig(raw, { basePath }), dir };
}

/** The server state that matches `desired` exactly. */
function matching(desired: DesiredProxyFiles, domains: string[]): ProxyFileState {
  const each = <T>(v: T) => Object.fromEntries(domains.map((d) => [d, v]));
  return {
    vhost: each(sha(desired.vhost.server)),
    location: each(desired.vhost.location === null ? null : sha(desired.vhost.location)),
    cert: desired.certs ? { crt: desired.certs.crt, key: desired.certs.key, linkedDomains: [...domains] } : { crt: null, key: null, linkedDomains: [] },
    upstream: desired.lb ? 'ip_hash;\n' : null,
    upstreamLinks: desired.lb ? [...domains] : [],
    serviceScript: desired.serviceScript,
    serviceRunning: desired.serviceScript !== null,
    proxyRunning: true,
  };
}

const DOMAINS = ['a.example.com', 'www.a.example.com'];
const DESIRED: DesiredProxyFiles = {
  vhost: { server: 'client_max_body_size 10M;\n\n', location: null },
  certs: null,
  lb: false,
  serviceScript: null,
};

/** A connection that records every call; `answer` gives the stdout of exec/runScript. */
function fakeConn(answer: (script: string) => string = () => '') {
  const calls: Array<{ kind: 'exec' | 'script' | 'write'; text: string; content?: string; mode?: number }> = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const conn = {
    name: 'one',
    host: '192.0.2.1',
    async exec(command: string, o: ExecOptions = {}) {
      calls.push({ kind: 'exec', text: command, content: typeof o.stdin === 'string' ? o.stdin : undefined });
      return ok(answer(command));
    },
    async runScript(script: string) {
      calls.push({ kind: 'script', text: script });
      return ok(answer(script));
    },
    async runScriptOrThrow(script: string) {
      calls.push({ kind: 'script', text: script });
      return ok(answer(script));
    },
    async writeFile(path: string, content: string, mode?: number) {
      calls.push({ kind: 'write', text: path, content, mode });
    },
  };
  return { conn: conn as unknown as SshConnection, calls };
}

describe('planProxySync', () => {
  it('plans nothing when the server matches the config', () => {
    const plan = planProxySync(DESIRED, matching(DESIRED, DOMAINS), DOMAINS);
    expect(plan).toEqual({ before: [], after: [], regenerate: { before: false, after: false }, lbTransition: 'none', changes: [] });
  });

  it('rewrites a changed vhost file with a reload only, and regenerates for a new one', () => {
    const changed = matching(DESIRED, DOMAINS);
    changed.vhost['www.a.example.com'] = sha('client_max_body_size 1M;\n\n');
    const p1 = planProxySync(DESIRED, changed, DOMAINS);
    expect(p1.before).toEqual(['vhost']);
    expect(p1.regenerate.before).toBe(false);
    expect(p1.changes.join('\n')).toContain('www.a.example.com');

    const missing = matching(DESIRED, DOMAINS);
    missing.vhost['www.a.example.com'] = null;
    const p2 = planProxySync(DESIRED, missing, DOMAINS);
    expect(p2.before).toEqual(['vhost']);
    expect(p2.regenerate.before).toBe(true);
  });

  it('regenerates when nginxLocationConfig is added or removed', () => {
    const withLocation: DesiredProxyFiles = { ...DESIRED, vhost: { ...DESIRED.vhost, location: 'gzip on;\n' } };
    const added = planProxySync(withLocation, matching(DESIRED, DOMAINS), DOMAINS);
    expect(added.before).toEqual(['vhost']);
    expect(added.regenerate.before).toBe(true);

    const removed = planProxySync(DESIRED, matching(withLocation, DOMAINS), DOMAINS);
    expect(removed.before).toEqual(['vhost']);
    expect(removed.regenerate.before).toBe(true);
  });

  it('replaces changed certificates and regenerates', () => {
    const desired: DesiredProxyFiles = { ...DESIRED, certs: { crt: sha('crt'), key: sha('key') } };
    const current = matching(desired, DOMAINS);
    current.cert.crt = sha('old crt');
    const plan = planProxySync(desired, current, DOMAINS);
    expect(plan.before).toEqual(['certs']);
    expect(plan.regenerate.before).toBe(true);
  });

  it('removes the certificates of a config that no longer has ssl.crt', () => {
    const withCerts: DesiredProxyFiles = { ...DESIRED, certs: { crt: sha('crt'), key: sha('key') } };
    const plan = planProxySync(DESIRED, matching(withCerts, DOMAINS), DOMAINS);
    expect(plan.before).toEqual(['certs']);
  });

  it('enables load balancing after the activation and disables it before', () => {
    const lb: DesiredProxyFiles = { ...DESIRED, lb: true, serviceScript: '#!/bin/bash\n' };
    const enable = planProxySync(lb, matching(DESIRED, DOMAINS), DOMAINS);
    expect(enable.lbTransition).toBe('enable');
    expect(enable.before).toEqual([]);
    expect(enable.after).toEqual(['lb-enable', 'service']);
    expect(enable.regenerate.after).toBe(true);

    const disable = planProxySync(DESIRED, matching(lb, DOMAINS), DOMAINS);
    expect(disable.lbTransition).toBe('disable');
    expect(disable.before).toEqual(['lb-remove']);
    expect(disable.regenerate.before).toBe(true);
    expect(disable.after).toEqual([]);
  });

  it('keeps load balancing: updates the config container when its script changed or it is not running', () => {
    const lb: DesiredProxyFiles = { ...DESIRED, lb: true, serviceScript: '#!/bin/bash\n# new\n' };
    const same = planProxySync(lb, matching(lb, DOMAINS), DOMAINS);
    expect(same.lbTransition).toBe('keep');
    expect(same.after).toEqual([]);

    const old = matching(lb, DOMAINS);
    old.serviceScript = '#!/bin/bash\n# old\n';
    expect(planProxySync(lb, old, DOMAINS).after).toEqual(['service']);

    const stopped = matching(lb, DOMAINS);
    stopped.serviceRunning = false;
    expect(planProxySync(lb, stopped, DOMAINS).after).toEqual(['service']);
  });

  it('keeps load balancing: relinks the upstream when the domains changed', () => {
    const lb: DesiredProxyFiles = { ...DESIRED, lb: true, serviceScript: '#!/bin/bash\n' };
    const current = matching(lb, DOMAINS);
    current.upstreamLinks = ['a.example.com'];
    const plan = planProxySync(lb, current, DOMAINS);
    expect(plan.lbTransition).toBe('keep');
    expect(plan.after).toEqual(['lb-links']);
    expect(plan.regenerate.after).toBe(true);
  });
});

describe('desiredProxyFiles', () => {
  it('hashes the custom certificate and computes the vhost files', async () => {
    const { c, dir } = load('proxy-certs');
    const d = await desiredProxyFiles(c, dir);
    expect(d.vhost.server.startsWith('client_max_body_size 50M;\n')).toBe(true);
    expect(d.vhost.location).not.toBeNull();
    expect(d.certs?.crt).toMatch(/^[0-9a-f]{64}$/);
    expect(d.lb).toBe(false);
    expect(d.serviceScript).toBeNull();
  });

  it('names proxy.ssl.key and its path when the key cannot be read', async () => {
    const { c, dir } = load('proxy-certs', (raw) => {
      raw.proxy.ssl.key = './missing.key';
    });
    const err = await desiredProxyFiles(c, dir).catch((e) => e);
    expect(err).toBeInstanceOf(CometError);
    expect(String(err.message)).toMatch(/proxy\.ssl\.key.*missing\.key/);
  });

  it('gives the config container script of a load-balanced app', async () => {
    const { c, dir } = load('proxy-lb');
    const d = await desiredProxyFiles(c, dir);
    expect(d.lb).toBe(true);
    expect(d.serviceScript).toBe(await serviceScriptContent(c));
  });
});

describe('serviceScriptContent', () => {
  it('equals what service-configure.sh writes into proxy-config-container.sh', async () => {
    const { c } = load('proxy-lb');
    const script = await renderServiceConfigureSh(c);
    const start = script.indexOf('NEW_CONTENT="$(cat <<-CONFIG_EOT');
    const end = script.indexOf('CONFIG_EOT\n)"', start) + 'CONFIG_EOT\n)"'.length;
    const fileContent = execFileSync('bash', ['-c', `${script.slice(start, end)}\necho "$NEW_CONTENT"`], { encoding: 'utf8' });
    expect(await serviceScriptContent(c)).toBe(fileContent);
  });
});

describe('readProxyFileState', () => {
  it('parses the key=value output of proxy-state.sh', async () => {
    const { c } = load('proxy-certs');
    const [d0, d1] = proxyDomains(c);
    const output = [
      `vhost.0=${sha('v0')}`,
      'vhost.1=-',
      `location.0=${sha('l0')}`,
      'location.1=-',
      `crt=${sha('crt')}`,
      'key=-',
      `certlinks=${b64(`${d0}\n`)}`,
      `upstream=${b64('\nip_hash;\n\nserver 10.0.0.1:4000;\n\n')}`,
      `upstreamlinks=${b64(`${d0}\n${d1}\n`)}`,
      'service=-',
      'serviceRunning=0',
      'proxyRunning=1',
    ].join('\n');
    const { conn, calls } = fakeConn(() => `${output}\n`);
    const s = await readProxyFileState(conn, c);
    expect(s).toEqual({
      vhost: { [d0]: sha('v0'), [d1]: null },
      location: { [d0]: sha('l0'), [d1]: null },
      cert: { crt: sha('crt'), key: null, linkedDomains: [d0] },
      upstream: '\nip_hash;\n\nserver 10.0.0.1:4000;\n\n',
      upstreamLinks: [d0, d1],
      serviceScript: null,
      serviceRunning: false,
      proxyRunning: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(`${d1}_location`);
  });
});

describe('applyProxySync', () => {
  it('uploads the certificate and key over SFTP, the key with mode 0600 and never in a command', async () => {
    const { c, dir } = load('proxy-certs');
    const { conn, calls } = fakeConn();
    const plan = planProxySync(await desiredProxyFiles(c, dir), { ...matching(DESIRED, proxyDomains(c)), cert: { crt: null, key: null, linkedDomains: [] } }, proxyDomains(c));
    expect(plan.before).toContain('certs');
    await applyProxySync(conn, c, dir, plan, 'before');

    const key = execFileSync('cat', [join(dir, 'cert.key')], { encoding: 'utf8' });
    const keyWrite = calls.find((x) => x.kind === 'write' && x.text === '/opt/certs-app/config/private.key');
    expect(keyWrite?.mode).toBe(0o600);
    expect(keyWrite?.content).toBe(key);
    expect(calls.some((x) => x.kind === 'write' && x.text === '/opt/certs-app/config/bundle.crt')).toBe(true);
    for (const x of calls.filter((y) => y.kind !== 'write')) {
      expect(x.text).not.toContain(key.trim());
      expect(x.content ?? '').not.toContain(key.trim());
    }
    const scripts = calls.filter((x) => x.kind === 'script').map((x) => x.text);
    // ssl-cleanup.sh before the upload, ssl-setup.sh after it, then one regeneration.
    expect(scripts.findIndex((s) => s.includes('rm -rf /opt/certs-app/config/bundle.crt'))).toBeLessThan(scripts.findIndex((s) => s.includes('ln -s $APP_CERTS/bundle.crt')));
    expect(scripts.at(-1)).toContain('docker-gen');
  });

  it('hands the proxy directory to the SSH user before it writes there, as MUP setup does', async () => {
    // start.sh (run with sudo) and the Let's Encrypt companion create root-owned files there; a
    // non-root SSH user could not replace them (ssl-setup.sh copies certificates without sudo).
    const { c, dir } = load('proxy-certs');
    const { conn, calls } = fakeConn();
    const plan = planProxySync(await desiredProxyFiles(c, dir), { ...matching(DESIRED, proxyDomains(c)), cert: { crt: null, key: null, linkedDomains: [] } }, proxyDomains(c));
    await applyProxySync(conn, c, dir, plan, 'before');
    expect(calls[0]).toMatchObject({ kind: 'exec', text: 'sudo chown "$USER" /opt/mup-nginx-proxy -R' });
  });

  it('only reloads nginx after rewriting an existing vhost file', async () => {
    const { c, dir } = load('proxy-certs', (raw) => {
      delete raw.proxy.ssl;
    });
    const desired = await desiredProxyFiles(c, dir);
    const current = matching(desired, proxyDomains(c));
    current.vhost[proxyDomains(c)[0]] = sha('old');
    const plan = planProxySync(desired, current, proxyDomains(c));
    const { conn, calls } = fakeConn();
    await applyProxySync(conn, c, dir, plan, 'before');
    const scripts = calls.filter((x) => x.kind === 'script').map((x) => x.text);
    expect(scripts[0]).toContain('cd /opt/mup-nginx-proxy/config/vhost.d');
    expect(scripts.at(-1)).toContain('nginx -s reload');
    expect(scripts.join('\n')).not.toContain('docker-gen');
  });

  it('enables load balancing with the MUP upstream file and the config container', async () => {
    const { c, dir } = load('proxy-lb');
    const desired = await desiredProxyFiles(c, dir);
    const plan = planProxySync(desired, matching({ ...desired, lb: false, serviceScript: null }, proxyDomains(c)), proxyDomains(c));
    const { conn, calls } = fakeConn();
    await applyProxySync(conn, c, dir, plan, 'before');
    expect(calls).toHaveLength(0);
    await applyProxySync(conn, c, dir, plan, 'after');
    const scripts = calls.filter((x) => x.kind === 'script').map((x) => x.text);
    expect(scripts[0]).toContain(b64(formatUpstream(c, desiredEntries(c))));
    expect(scripts[1]).toContain('mup-proxy-configure-production');
    expect(scripts.at(-1)).toContain('docker-gen');
  });

  it('disables load balancing before the activation and removes the config container', async () => {
    const { c, dir } = load('proxy-lb', (raw) => {
      raw.proxy.loadBalancing = false;
      raw.app.env.PORT = 80;
    });
    const desired = await desiredProxyFiles(c, dir);
    const plan = planProxySync(desired, matching({ ...desired, lb: true, serviceScript: '#!/bin/bash\n' }, proxyDomains(c)), proxyDomains(c));
    const { conn, calls } = fakeConn();
    await applyProxySync(conn, c, dir, plan, 'before');
    const all = calls.map((x) => x.text).join('\n');
    expect(all).toContain('sudo rm -f $UPSTREAM');
    expect(all).toContain('docker rm -f mup-proxy-configure-production');
    expect(calls.at(-1)?.text).toContain('docker-gen');
  });
});

describe('writeUpstreamFile and regenerateNginx', () => {
  it('writes the content atomically, links every domain and reloads nginx, all with sudo', async () => {
    const { c } = load('proxy-lb');
    const { conn, calls } = fakeConn();
    await writeUpstreamFile(conn, c, 'ip_hash;\n');
    const s = calls[0].text;
    expect(s).toContain(b64('ip_hash;\n'));
    expect(s).toContain('sudo mv');
    expect(s).toContain("ln -sfn ../upstream/$APPNAME 'lb.example.com_upstream'");
    expect(s).toContain('sudo docker exec $PROXYNAME nginx -s reload');
  });

  it('removes the upstream file and this app’s links for null', async () => {
    const { c } = load('proxy-lb');
    const { conn, calls } = fakeConn();
    await writeUpstreamFile(conn, c, null);
    expect(calls[0].text).toContain("APPNAME='production'");
    expect(calls[0].text).toContain('sudo rm -f $UPSTREAM');
    expect(calls[0].text).not.toContain('base64 -d');
    // nginx still includes the file; the caller regenerates instead of reloading.
    expect(calls[0].text).not.toContain('nginx -s reload');
  });

  it('regenerates the nginx config with docker-gen inside the proxy container', async () => {
    const { conn, calls } = fakeConn();
    await regenerateNginx(conn);
    const s = calls[0].text;
    expect(s).toContain('sudo docker exec mup-nginx-proxy docker-gen /app/nginx.tmpl /etc/nginx/conf.d/default.conf');
    // nginx -t before the reload, so a rejected config fails the step instead of passing silently.
    expect(s.indexOf('nginx -t')).toBeGreaterThan(s.indexOf('docker-gen'));
    expect(s.indexOf('nginx -s reload')).toBeGreaterThan(s.indexOf('nginx -t'));
  });
});
