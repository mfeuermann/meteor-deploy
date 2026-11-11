import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { lbPort } from '../../../src/config/deterministic.js';
import {
  PROXY_DIR,
  PROXY_NAME,
  customCertFiles,
  loadBalancingHosts,
  proxyDomains,
  proxyServers,
  readNginxTmpl,
  renderNginxConfigSh,
  renderProxySetupSh,
  renderProxyStartScript,
  renderProxyStartSh,
  renderProxyStopSh,
  renderServiceConfigureSh,
  renderSharedFiles,
  renderSslCleanupSh,
  renderSslSetupSh,
  vhostContent,
} from '../../../src/proxy/render.js';
import { templatePath } from '../../../src/remote/render.js';
import { mupNormalize } from '../../oracle/mup-oracle.js';
import { tempDir } from '../../helpers/fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');
const require = createRequire(import.meta.url);
const mupProxyAssets = join(dirname(require.resolve('mup/package.json')), 'lib/plugins/proxy/assets');
const ejs = require('@zodern/ejs');

/** MUP's own rendering of one of its proxy assets. */
function mup(rel: string, vars: Record<string, unknown>): string {
  const path = join(mupProxyAssets, rel);
  return ejs.render(readFileSync(path, 'utf8'), vars, { filename: path });
}

function load(name: string): { config: NormalizedConfig; dir: string } {
  const dir = join(fixtures, name);
  const { raw, basePath } = loadConfig(dir, './mup.js');
  return { config: normalizeConfig(raw, { basePath }), dir };
}

/** Every file under `root`, as paths relative to `root`. */
function files(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(root, p) : [relative(root, p)];
  });
}

const FIXTURES = ['proxy-le', 'proxy-lb', 'proxy-certs', 'proxy-shared'];

describe('MUP proxy templates', () => {
  it('are byte-identical copies of MUP 1.5.11 proxy assets, none missing', () => {
    const ours = templatePath('mup/proxy');
    expect(files(ours).sort()).toEqual(files(mupProxyAssets).sort());
    for (const f of files(mupProxyAssets)) {
      expect(readFileSync(join(ours, f), 'utf8'), f).toBe(readFileSync(join(mupProxyAssets, f), 'utf8'));
    }
  });
});

describe('proxy renderers equal MUP command-handlers output', () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      const { config: c, dir } = load(name);
      const m = await mupNormalize(join(dir, 'mup.js'));
      const p = m.proxy;
      const appName = m.app.name;
      const domains = p.domains.split(',');
      const read = (f?: string) => (f ? readFileSync(join(dir, f), 'utf8') : '');

      expect(await renderProxySetupSh(c)).toBe(mup('proxy-setup.sh', { name: PROXY_NAME, appName }));
      expect(await renderProxyStartSh(c)).toBe(
        mup('templates/start.sh', { appName: PROXY_NAME, letsEncryptEmail: p.ssl ? p.ssl.letsEncryptEmail : null, swarmEnabled: false }),
      );
      expect(await readNginxTmpl()).toBe(readFileSync(join(mupProxyAssets, 'nginx.tmpl'), 'utf8'));
      expect(await renderNginxConfigSh(c, dir)).toBe(
        mup('nginx-config.sh', {
          hasServerConfig: p.nginxServerConfig,
          hasLocationConfig: p.nginxLocationConfig,
          serverConfig: read(p.nginxServerConfig),
          locationConfig: read(p.nginxLocationConfig),
          domains,
          proxyName: PROXY_NAME,
          clientUploadLimit: p.clientUploadLimit || '10M',
        }),
      );
      expect(await renderSslCleanupSh(c)).toBe(mup('ssl-cleanup.sh', { name: appName, proxyName: PROXY_NAME }));
      expect(await renderSslSetupSh(c)).toBe(mup('ssl-setup.sh', { appName, proxyName: PROXY_NAME, domains }));
      // MUP passes addProxyEnv(config, {}): no LETSENCRYPT_EMAIL (it lands on app.env) and, with
      // load balancing, the random port even when app.env.PORT is set.
      const serviceEnv: Record<string, unknown> = { VIRTUAL_HOST: p.domains, HTTPS_METHOD: p.ssl && p.ssl.forceSSL ? 'redirect' : 'noredirect' };
      if (p.ssl && p.ssl.letsEncryptEmail) serviceEnv.LETSENCRYPT_HOST = p.domains;
      if (p.loadBalancing) serviceEnv.PORT = lbPort(appName);
      expect(await renderServiceConfigureSh(c)).toBe(
        mup('service-configure.sh', { appName, imagePort: m.app.docker.imagePort, env: serviceEnv, domains, proxyName: PROXY_NAME, swarmEnabled: false }),
      );
      expect(await renderProxyStopSh()).toBe(mup('proxy-stop.sh', { appName: PROXY_NAME }));
      expect(await renderProxyStartScript()).toBe(mup('proxy-start.sh', { appName: PROXY_NAME }));

      const shared = p.shared || {};
      const sf = await renderSharedFiles(c, { basePath: dir, cwd: dir });
      expect(sf.sharedConfigSh).toBe(
        mup('templates/shared-config.sh', { httpPort: shared.httpPort, httpsPort: shared.httpsPort, clientUploadLimit: shared.clientUploadLimit }),
      );
      expect(sf.envList).toBe(mup('templates/env.list', { env: shared.env || {} }));
      expect(sf.envLetsEncryptList).toBe(mup('templates/env.list', { env: shared.envLetsEncrypt || {} }));
      expect(sf.nginxDefaultConf).toBe(shared.nginxConfig ? read(shared.nginxConfig) : readFileSync(join(mupProxyAssets, 'proxy.conf'), 'utf8'));
      expect(sf.template).toBe(shared.templatePath ? read(shared.templatePath) : null);
    });
  }

  it('renders the cleanup of the shared template', async () => {
    const { renderCleanupTemplateSh } = await import('../../../src/proxy/render.js');
    expect(await renderCleanupTemplateSh()).toBe(mup('cleanup-template.sh', { appName: PROXY_NAME }));
  });
});

describe('vhostContent', () => {
  for (const name of FIXTURES) {
    it(`${name}: equals what nginx-config.sh writes for each domain`, async () => {
      const { config: c, dir } = load(name);
      const out = tempDir();
      const script = (await renderNginxConfigSh(c, dir)).replace(`cd ${PROXY_DIR}/config/vhost.d`, `cd ${out}`);
      execFileSync('bash', ['-c', script]);
      const v = vhostContent(c, dir);
      for (const d of proxyDomains(c)) {
        expect(readFileSync(join(out, d), 'utf8'), d).toBe(v.server);
        if (v.location === null) expect(() => readFileSync(join(out, `${d}_location`))).toThrow();
        else expect(readFileSync(join(out, `${d}_location`), 'utf8')).toBe(v.location);
      }
    });
  }
});

describe('proxy server and host helpers', () => {
  it('runs the proxy on the app servers unless proxy.servers is set, filtered by --servers', () => {
    const { config } = load('proxy-lb');
    expect(proxyServers(config, null)).toEqual(['one', 'two']);
    expect(proxyServers(config, ['one'])).toEqual(['one']);
    const own = { ...config, proxy: { ...config.proxy, servers: { two: {} } } } as NormalizedConfig;
    expect(proxyServers(own, null)).toEqual(['two']);
  });

  it('lists the load balancing hosts of every app server (privateIp, else host)', () => {
    const { config } = load('proxy-lb');
    expect(loadBalancingHosts(config)).toEqual(['10.0.0.1', '10.0.0.2']);
    const noPrivate = { ...config, servers: { ...config.servers, two: { ...config.servers.two, privateIp: undefined } } } as NormalizedConfig;
    expect(loadBalancingHosts(noPrivate)).toEqual(['10.0.0.1', '192.0.2.51']);
  });

  it('splits domains like MUP, without trimming', () => {
    const { config } = load('proxy-le');
    const spaced = { ...config, proxy: { ...config.proxy, domains: 'a.com, b.com' } } as NormalizedConfig;
    expect(proxyDomains(spaced)).toEqual(['a.com', ' b.com']);
  });

  it('uploads custom certificates only for ssl.crt without Let’s Encrypt and with upload enabled', () => {
    const { config, dir } = load('proxy-certs');
    expect(customCertFiles(config, dir)).toEqual({ crt: join(dir, 'cert.crt'), key: join(dir, 'cert.key') });
    const noUpload = { ...config, proxy: { ...config.proxy, ssl: { ...config.proxy!.ssl, upload: false } } } as NormalizedConfig;
    expect(customCertFiles(noUpload, dir)).toBeNull();
    expect(customCertFiles(load('proxy-le').config, dir)).toBeNull();
  });

  it('names the config key and the path of a file that cannot be read', async () => {
    const { config, dir } = load('proxy-certs');
    const broken = { ...config, proxy: { ...config.proxy, nginxServerConfig: './missing.conf' } } as NormalizedConfig;
    await expect(renderNginxConfigSh(broken, dir)).rejects.toThrow(/proxy\.nginxServerConfig.*missing\.conf/);
    expect(() => vhostContent(broken, dir)).toThrow(/proxy\.nginxServerConfig.*missing\.conf/);
  });
});
