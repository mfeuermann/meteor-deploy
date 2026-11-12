/**
 * The reverse proxy end to end on one fake server, as the non-root `deployer` user (proxy plan
 * Task 8, Review Focus 1 and 2): setup and deploy behind MUP's proxy with Let's Encrypt (from
 * Pebble), proxy restarts only when needed, app proxy files synced by deploy, zero-downtime
 * switches for every command, a failed health check behind the proxy, a custom certificate and
 * its replacement, Docker 29, and a second app on the same proxy.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeDockerVersion, type FakeServer } from '../harness/fake-servers.js';
import { pebbleEnv, startPebble } from '../harness/pebble.js';
import { APP_NAME, cli, curlVia, requestLoop, sampleProject, waitFor, writeTestConfig } from './helpers.js';

const DOMAIN = 'app.test';
const PROXY = 'mup-nginx-proxy';
const VHOST_D = `/opt/${PROXY}/config/vhost.d`;

type Project = ReturnType<typeof sampleProject>;

/** The proxy section with Let's Encrypt from Pebble; `extra` adds or replaces keys. */
const leProxy = (extra: Record<string, unknown> = {}) => ({
  domains: DOMAIN,
  ssl: { letsEncryptEmail: `admin@${DOMAIN}` },
  shared: { envLetsEncrypt: pebbleEnv() },
  ...extra,
});

const proxyStartedAt = async (s: FakeServer) => (await s.exec(`docker inspect -f '{{.State.StartedAt}}' ${PROXY}`)).stdout.trim();
const nginxConf = async (s: FakeServer) => (await s.exec(`docker exec ${PROXY} cat /etc/nginx/conf.d/default.conf`)).stdout;
const appAnswers = (s: FakeServer, host = DOMAIN) => waitFor(async () => (await curlVia(s, host, '/native')) === '60', 120_000, 1000);

/** The SHA-256 fingerprint of a PEM certificate, as upper-case hex without separators. */
function fingerprint(pemOrOpensslOutput: string): string {
  const m = /Fingerprint=([0-9A-Fa-f:]+)/.exec(pemOrOpensslOutput);
  return (m?.[1] ?? '').replace(/:/g, '').toUpperCase();
}

/** A self-signed certificate for DOMAIN written to `<dir>/bundle.crt` and `<dir>/private.key`; returns its fingerprint. */
function makeCert(dir: string, cn: string): string {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${cn}`, '-keyout', join(dir, 'private.key'), '-out', join(dir, 'bundle.crt')], {
    stdio: 'ignore',
  });
  return fingerprint(execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', join(dir, 'bundle.crt')], { encoding: 'utf8' }));
}

/** The fingerprint of the certificate nginx serves for DOMAIN on port 443 of the fake server. */
async function servedFingerprint(s: FakeServer): Promise<string> {
  const r = await s.exec(`echo | openssl s_client -connect localhost:443 -servername ${DOMAIN} 2>/dev/null | openssl x509 -noout -fingerprint -sha256`);
  return fingerprint(r.stdout);
}

/**
 * Runs `args` while requests go through the proxy; returns the CLI result, the request counts and
 * the server's Docker events meanwhile (to tell when a failed request happened).
 */
async function underLoad(s: FakeServer, args: string[], cwd: string) {
  const events = `/tmp/comet-events-${Date.now()}.log`;
  await s.exec(`setsid nohup docker events --format '{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}}' > ${events} 2>&1 &`);
  const loop = await requestLoop(s, DOMAIN);
  const r = await cli(args, cwd);
  // A few more requests after the command, while the old container is gone for good.
  await new Promise((res) => setTimeout(res, 2000));
  const requests = await loop.stop();
  await s.exec(`pkill -f 'docker events --format' || true`);
  const log = (await s.exec(`grep -vE ' (exec_create|exec_die) ' ${events} | cut -c1-140`)).stdout;
  return { ...r, requests: { ...requests, codes: requests.failed ? [...requests.codes, `\nDocker events:\n${log}`] : requests.codes } };
}

/**
 * Steps 1 and 2 of the plan: setup, the shared settings that point the companion at Pebble,
 * deploy, the app answers through the proxy, and `proxy status` shows the issued certificate.
 */
async function setupAndDeploy(server: FakeServer, p: Project): Promise<void> {
  const config = ['--config', join(p.deployDir, 'mup.js')];
  writeTestConfig(p.deployDir, [server], { proxy: leProxy() });
  const setup = await cli(['setup', ...config], p.root);
  expect(setup.code, setup.output).toBe(0);
  // MUP's setup does not apply proxy.shared; reconfig-shared does (and restarts the proxy).
  const shared = await cli(['proxy', 'reconfig-shared', ...config], p.root);
  expect(shared.code, shared.output).toBe(0);
  await startPebble(server);
  const deploy = await cli(['deploy', ...config], p.root);
  expect(deploy.code, deploy.output).toBe(0);
  // The shared settings on the server are the config's: no drift warning.
  expect(deploy.output).not.toContain('reconfig-shared');
  expect(await appAnswers(server)).toBe(true);
  const issued = await waitFor(
    async () => /app\.test\.chain\.pem: \S/.test((await cli(['proxy', 'status', ...config], p.root)).output),
    180_000,
    3000,
  );
  if (!issued) {
    const le = await server.exec(`docker logs ${PROXY}-letsencrypt 2>&1 | tail -40`);
    expect.fail(`no certificate for ${DOMAIN} in "proxy status"; companion log:\n${le.stdout}`);
  }
}

describe('proxy: Let\'s Encrypt via Pebble, deployer user, Docker 27.5', () => {
  let server: FakeServer;
  let p: Project;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const write = (o: Parameters<typeof writeTestConfig>[2] = {}) => writeTestConfig(p.deployDir, [server], { proxy: leProxy(), ...o });

  beforeAll(async () => {
    [server] = await startFakeServers(1, { user: 'deployer' });
    p = sampleProject();
  }, 1_500_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('1+2. setup and deploy: the app answers through the proxy with a certificate from Pebble', async () => {
    await setupAndDeploy(server, p);
  }, 1_200_000);

  it('3. a second setup does not restart the proxy; proxy start does', async () => {
    const before = await proxyStartedAt(server);
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    expect(setup.output).toContain('proxy up to date');
    expect(await proxyStartedAt(server)).toBe(before);
    const start = await cli(['proxy', 'start', ...config()], p.root);
    expect(start.code, start.output).toBe(0);
    expect(await proxyStartedAt(server)).not.toBe(before);
    // The companion was recreated, and Pebble's network with it.
    await startPebble(server);
    expect(await appAnswers(server)).toBe(true);
  });

  it('4. deploy syncs the upload limit and a new location file without restarting the proxy', async () => {
    writeFileSync(join(p.deployDir, 'location.conf'), 'add_header X-Comet-Location "yes";\n');
    write({ proxy: leProxy({ clientUploadLimit: '20M', nginxLocationConfig: './location.conf' }) });
    const before = await proxyStartedAt(server);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await nginxConf(server)).toContain(`include /etc/nginx/vhost.d/${DOMAIN}_location;`);
    expect((await server.exec(`sudo cat ${VHOST_D}/${DOMAIN}`)).stdout).toContain('client_max_body_size 20M;');
    expect(await proxyStartedAt(server)).toBe(before);
    expect(await appAnswers(server)).toBe(true);
  });

  it('5. deploy, reconfig, rollback and restart switch without a failed request', async () => {
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// proxy test change ${Date.now()}\n`);
    for (const command of ['deploy', 'reconfig', 'rollback', 'restart']) {
      const r = await underLoad(server, [command, ...config()], p.root);
      expect(r.code, `${command}:\n${r.output}`).toBe(0);
      expect(r.output, command).not.toContain('Zero-downtime switch not used');
      expect(r.requests.total, command).toBeGreaterThan(20);
      expect(r.requests.failed, `${command}: failed requests (${r.requests.codes.join(',')}) of ${r.requests.total}`).toBe(0);
    }
  });

  it('6. a failed health check behind the proxy keeps the old container serving', async () => {
    write({ proxy: leProxy({ clientUploadLimit: '20M', nginxLocationConfig: './location.conf' }), env: { CRASH_ON_START: '1' } });
    try {
      const r = await underLoad(server, ['reconfig', ...config()], p.root);
      expect(r.code, r.output).toBe(1);
      expect(r.output).toMatch(/s1\s+-\s+reverted/);
      expect(r.requests.failed, `failed requests (${r.requests.codes.join(',')}) of ${r.requests.total}`).toBe(0);
      const names = (await server.exec(`docker ps -a --format '{{.Names}}'`)).stdout.split('\n');
      expect(names).toContain(APP_NAME);
      expect(names).not.toContain(`${APP_NAME}-next`);
    } finally {
      write({ proxy: leProxy({ clientUploadLimit: '20M', nginxLocationConfig: './location.conf' }) });
    }
  });

  it('7. a custom certificate replaces Let\'s Encrypt, and a new one replaces it on deploy', async () => {
    const custom = (extra: Record<string, unknown> = {}) => ({ domains: DOMAIN, ssl: { crt: './bundle.crt', key: './private.key' }, ...extra });
    const first = makeCert(p.deployDir, `${DOMAIN} first`);
    write({ proxy: custom() });
    const a = await cli(['deploy', ...config()], p.root);
    expect(a.code, a.output).toBe(0);
    expect(await waitFor(async () => (await servedFingerprint(server)) === first, 30_000, 1000)).toBe(true);

    const second = makeCert(p.deployDir, `${DOMAIN} second`);
    expect(second).not.toBe(first);
    const b = await cli(['deploy', ...config()], p.root);
    expect(b.code, b.output).toBe(0);
    expect(await waitFor(async () => (await servedFingerprint(server)) === second, 30_000, 1000)).toBe(true);
    expect(await appAnswers(server)).toBe(true);
  });

  it('9. a second app on the same proxy leaves the first app\'s files alone (Review Focus 1)', async () => {
    const appFiles = async () =>
      (
        await server.exec(
          `cd /opt/${PROXY} && sudo find config/vhost.d mounted-certs -maxdepth 1 -name '${DOMAIN}*' ! -type d | sort | sudo xargs -r sha256sum`,
        )
      ).stdout;
    const before = await appFiles();
    expect(before).toContain(`config/vhost.d/${DOMAIN}`);

    const dir2 = join(p.root, '.deploy2');
    mkdirSync(dir2, { recursive: true });
    writeTestConfig(dir2, [server], { name: `${APP_NAME}2`, proxy: { domains: 'app2.test' } });
    const config2 = ['--config', join(dir2, 'mup.js')];
    const setup = await cli(['setup', ...config2], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await cli(['deploy', ...config2], p.root);
    expect(deploy.code, deploy.output).toBe(0);

    expect(await appAnswers(server, 'app2.test')).toBe(true);
    expect(await appFiles()).toBe(before);
    expect(await curlVia(server, DOMAIN, '/native')).toBe('60');
  });
});

describe('proxy on Docker 29 (spec §5)', () => {
  let server: FakeServer;
  let p: Project;
  const docker: FakeDockerVersion = '29';

  beforeAll(async () => {
    [server] = await startFakeServers(1, { user: 'deployer', docker });
    p = sampleProject();
  }, 1_500_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('1+2. setup and deploy with a certificate from Pebble', async () => {
    const version = (await server.exec(`docker version --format '{{.Server.Version}}'`)).stdout.trim();
    expect(version.startsWith('29.')).toBe(true);
    await setupAndDeploy(server, p);
  }, 1_200_000);

  it('5. a deploy under load switches without a failed request', async () => {
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// docker 29 change ${Date.now()}\n`);
    const r = await underLoad(server, ['deploy', '--config', join(p.deployDir, 'mup.js')], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toContain('Zero-downtime switch not used');
    expect(r.requests.failed, `failed requests (${r.requests.codes.join(',')}) of ${r.requests.total}`).toBe(0);
  });
});
