/**
 * Renders MUP 1.5.11's reverse proxy scripts (`templates/mup/proxy/**`, byte-identical copies of
 * `lib/plugins/proxy/assets`) with exactly the variables MUP's `command-handlers.js` passes, plus
 * the helpers that tell where the proxy runs and what it routes to. Everything here is pure or
 * only reads local files; nothing touches a server.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveUserPath } from '../config/load.js';
import { lbPort } from '../config/deterministic.js';
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { renderTemplate, templatePath } from '../remote/render.js';

/** The shared proxy's container name, as in MUP (`PROXY_CONTAINER_NAME`). */
export const PROXY_NAME = 'mup-nginx-proxy';
/** Where MUP keeps the shared proxy's files on a server. */
export const PROXY_DIR = `/opt/${PROXY_NAME}`;

/** The error for a proxy server without a running proxy, after `Server "<name>": `. */
export const PROXY_NOT_SET_UP = `the reverse proxy is not set up (container ${PROXY_NAME} is missing or stopped). Run "comet-deploy proxy setup" first.`;

/** The error for turning off load balancing while `proxy.servers` has servers without the app (deploy and `proxy setup`). */
export const LB_OFF_WITHOUT_BACKEND =
  'Turning off loadBalancing while the proxy runs on servers without the app would leave those proxies without a backend. Remove proxy.servers first or keep loadBalancing.';

/** The `proxy` section; callers only use these helpers for configs that have one. */
function proxyOf(c: NormalizedConfig): Record<string, any> {
  if (!c.proxy) throw new CometError('The config has no "proxy" section.');
  return c.proxy;
}

/**
 * The servers the proxy runs on: `proxy.servers`, else the app servers (MUP `getSessions`),
 * filtered by `--servers` like every MUP command.
 */
export function proxyServers(c: NormalizedConfig, filter: string[] | null): string[] {
  const p = proxyOf(c);
  const all = Object.keys((p.servers as Record<string, unknown> | undefined) ?? c.app.servers ?? {});
  return filter ? all.filter((s) => filter.includes(s)) : all;
}

/** `proxy.domains` split on commas without trimming, as MUP does (`'a.com, b.com'` → `' b.com'`). */
export function proxyDomains(c: NormalizedConfig): string[] {
  return String(proxyOf(c).domains).split(',');
}

/** The upstream host of every app server, in `app.servers` order: `privateIp`, else `host` (MUP). */
export function loadBalancingHosts(c: NormalizedConfig): string[] {
  return Object.keys(c.app.servers ?? {}).map((name) => {
    const s = c.servers[name];
    return String(s?.privateIp || s?.host);
  });
}

/** The host port a load-balanced app publishes and the upstream points to (`app.env.PORT`). */
export function upstreamPort(c: NormalizedConfig): number {
  return Number(c.app.env?.PORT);
}

/** Reads a file named by a config key; a failure names the key and the path. */
export function readConfigFile(key: string, path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CometError(`Cannot read ${key} (${path}): ${(err as Error).message}`);
  }
}

/** A path from the `proxy` section, relative to the config's base path (MUP `api.resolvePath(basePath, …)`). */
function fromBase(p: string, basePath: string): string {
  return resolveUserPath(p, { cwd: basePath, basePath, base: 'config' });
}

/** The content of `proxy.<key>` read from the base path, or '' when the option is not set. */
function optionalFile(c: NormalizedConfig, key: 'nginxServerConfig' | 'nginxLocationConfig', basePath: string): string {
  const p = proxyOf(c)[key];
  return p ? readConfigFile(`proxy.${key}`, fromBase(String(p), basePath)) : '';
}

/** `proxy-setup.sh`: the proxy's directories, the app's config directory, the swarm network attempt. */
export function renderProxySetupSh(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/proxy/proxy-setup.sh', { name: PROXY_NAME, appName: c.app.name });
}

/** `templates/start.sh` → `/opt/mup-nginx-proxy/config/start.sh`: (re)creates both proxy containers. */
export function renderProxyStartSh(c: NormalizedConfig): Promise<string> {
  const ssl = proxyOf(c).ssl;
  return renderTemplate('mup/proxy/templates/start.sh', { appName: PROXY_NAME, letsEncryptEmail: ssl ? ssl.letsEncryptEmail : null, swarmEnabled: false });
}

/** MUP's `nginx.tmpl` as it is (copied to the server, not rendered). */
export function readNginxTmpl(): Promise<string> {
  return readFile(templatePath('mup/proxy/nginx.tmpl'), 'utf8');
}

/** `nginx-config.sh`: writes `vhost.d/<domain>` and `<domain>_location` for every domain. */
export function renderNginxConfigSh(c: NormalizedConfig, basePath: string): Promise<string> {
  const p = proxyOf(c);
  return (async () =>
    renderTemplate('mup/proxy/nginx-config.sh', {
      hasServerConfig: p.nginxServerConfig,
      hasLocationConfig: p.nginxLocationConfig,
      serverConfig: optionalFile(c, 'nginxServerConfig', basePath),
      locationConfig: optionalFile(c, 'nginxLocationConfig', basePath),
      domains: proxyDomains(c),
      proxyName: PROXY_NAME,
      clientUploadLimit: p.clientUploadLimit || '10M',
    }))();
}

/** ejs's `<%= %>` escaping, so computed file contents match what the rendered scripts write. */
function ejsEscape(s: string): string {
  return s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[ch]!);
}

/**
 * What `nginx-config.sh` writes into `vhost.d/<domain>` (`server`) and `vhost.d/<domain>_location`
 * (`location`, null when the file is removed), the same for every domain. These are the bodies of
 * its heredocs: the template's text up to the delimiter line, so each ends with an extra newline.
 */
export function vhostContent(c: NormalizedConfig, basePath: string): { server: string; location: string | null } {
  const p = proxyOf(c);
  const server = `client_max_body_size ${ejsEscape(String(p.clientUploadLimit || '10M'))};\n${optionalFile(c, 'nginxServerConfig', basePath)}\n`;
  const location = p.nginxLocationConfig ? `${optionalFile(c, 'nginxLocationConfig', basePath)}\n` : null;
  return { server, location };
}

/** `ssl-cleanup.sh`: removes the app's uploaded certificate and its copies in the proxy. */
export function renderSslCleanupSh(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/proxy/ssl-cleanup.sh', { name: c.app.name, proxyName: PROXY_NAME });
}

/** `ssl-setup.sh`: links and copies the uploaded certificate for every domain. */
export function renderSslSetupSh(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/proxy/ssl-setup.sh', { appName: c.app.name, proxyName: PROXY_NAME, domains: proxyDomains(c) });
}

/**
 * The env MUP gives the load-balancing config container: `addProxyEnv(config, {})`. That call
 * sets LETSENCRYPT_EMAIL on `app.env`, not on the new object, and with load balancing always
 * picks the app's random port (the new object has no PORT), even when `app.env.PORT` is set.
 */
function serviceEnv(c: NormalizedConfig): Record<string, unknown> {
  const p = proxyOf(c);
  const env: Record<string, unknown> = { VIRTUAL_HOST: p.domains, HTTPS_METHOD: p.ssl && p.ssl.forceSSL ? 'redirect' : 'noredirect' };
  if (p.ssl && p.ssl.letsEncryptEmail) env.LETSENCRYPT_HOST = p.domains;
  if (p.loadBalancing) env.PORT = lbPort(String(c.app.name));
  return env;
}

/** `service-configure.sh`: (re)creates `mup-proxy-configure-<app>` when its script changed or it is not running. */
export function renderServiceConfigureSh(c: NormalizedConfig): Promise<string> {
  return renderTemplate('mup/proxy/service-configure.sh', {
    appName: c.app.name,
    imagePort: c.app.docker.imagePort,
    env: serviceEnv(c),
    domains: proxyDomains(c),
    proxyName: PROXY_NAME,
    swarmEnabled: false,
  });
}

/** `proxy-stop.sh`: removes both proxy containers. */
export function renderProxyStopSh(): Promise<string> {
  return renderTemplate('mup/proxy/proxy-stop.sh', { appName: PROXY_NAME });
}

/** `proxy-start.sh`: runs `/opt/mup-nginx-proxy/config/start.sh`. */
export function renderProxyStartScript(): Promise<string> {
  return renderTemplate('mup/proxy/proxy-start.sh', { appName: PROXY_NAME });
}

/** `cleanup-template.sh`: removes `nginx-shared.tmpl` when `shared.templatePath` is not set. */
export function renderCleanupTemplateSh(): Promise<string> {
  return renderTemplate('mup/proxy/cleanup-template.sh', { appName: PROXY_NAME });
}

/**
 * The local certificate and key to upload, as MUP's setup does: only with `ssl.crt`, without
 * `letsEncryptEmail` and unless `ssl.upload` is false. Paths are relative to the base path.
 */
export function customCertFiles(c: NormalizedConfig, basePath: string): { crt: string; key: string } | null {
  const ssl = proxyOf(c).ssl;
  if (!ssl || ssl.letsEncryptEmail || ssl.upload === false || !ssl.crt) return null;
  return { crt: fromBase(String(ssl.crt), basePath), key: fromBase(String(ssl.key), basePath) };
}

/** The files `proxy reconfig-shared` uploads; `template` null means "remove nginx-shared.tmpl". */
export interface SharedFiles {
  sharedConfigSh: string;
  envList: string;
  envLetsEncryptList: string;
  nginxDefaultConf: string;
  template: string | null;
}

/**
 * The shared proxy settings as MUP's `reconfigShared` writes them. `shared.nginxConfig` is
 * relative to the base path; `shared.templatePath` is relative to the current directory, as in
 * MUP (ref. §2.4), with comet-deploy's fallback to the config directory.
 */
export async function renderSharedFiles(c: NormalizedConfig, o: { basePath: string; cwd: string }): Promise<SharedFiles> {
  const shared = (proxyOf(c).shared ?? {}) as Record<string, any>;
  const nginxDefaultConf = shared.nginxConfig
    ? readConfigFile('proxy.shared.nginxConfig', fromBase(String(shared.nginxConfig), o.basePath))
    : await readFile(templatePath('mup/proxy/proxy.conf'), 'utf8');
  const template = shared.templatePath
    ? readConfigFile('proxy.shared.templatePath', resolveUserPath(String(shared.templatePath), { cwd: o.cwd, basePath: o.basePath, base: 'cwd' }))
    : null;
  return {
    sharedConfigSh: await renderTemplate('mup/proxy/templates/shared-config.sh', {
      httpPort: shared.httpPort,
      httpsPort: shared.httpsPort,
      clientUploadLimit: shared.clientUploadLimit,
    }),
    envList: await renderTemplate('mup/proxy/templates/env.list', { env: { ...(shared.env ?? {}) } }),
    envLetsEncryptList: await renderTemplate('mup/proxy/templates/env.list', { env: { ...(shared.envLetsEncrypt ?? {}) } }),
    nginxDefaultConf,
    template,
  };
}
