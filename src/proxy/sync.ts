/**
 * Keeps one app's files in the shared proxy in line with its config on `deploy` and `reconfig`
 * (proxy spec §4.2), without restarting the proxy containers:
 *
 * - `vhost.d/<domain>` and `<domain>_location` (MUP's `nginx-config.sh`),
 * - the custom certificate and its links and copies (`ssl-cleanup.sh`, upload, `ssl-setup.sh`),
 * - with load balancing: `upstream/<app>`, the `vhost.d/<domain>_upstream` links and the config
 *   container `mup-proxy-configure-<app>` (`service-configure.sh`).
 *
 * The flow: `desiredProxyFiles` (local) and `readProxyFileState` (one script per server) feed the
 * pure `planProxySync`, and `applyProxySync` runs the planned steps of one phase: `before` the
 * app's activation (files for the domains, removing load balancing) or `after` it (enabling
 * load balancing). docker-gen decides which files exist when it generates the nginx config, so
 * a new or removed file needs a regeneration (`regenerateNginx`); a changed file only a reload.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NormalizedConfig } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { cometScript, shArg } from '../remote/ops.js';
import type { ExecOptions, SshConnection } from '../ssh/connection.js';
import {
  customCertFiles,
  PROXY_NAME,
  proxyDomains,
  readConfigFile,
  renderNginxConfigSh,
  renderServiceConfigureSh,
  renderSslCleanupSh,
  renderSslSetupSh,
  vhostContent,
} from './render.js';
import { desiredEntries, formatUpstream } from './upstream.js';

/** What a proxy server has for the app (`proxy-state.sh`). Hashes are sha256, null = missing. */
export interface ProxyFileState {
  /** domain → hash of `vhost.d/<domain>`. */
  vhost: Record<string, string | null>;
  /** domain → hash of `vhost.d/<domain>_location`. */
  location: Record<string, string | null>;
  /** Hashes of `/opt/<app>/config/bundle.crt` and `private.key`, and the domains whose `certs/<domain>.crt` links to it. */
  cert: { crt: string | null; key: string | null; linkedDomains: string[] };
  /** Content of `upstream/<app>`. */
  upstream: string | null;
  /** Domains whose `vhost.d/<domain>_upstream` links to `../upstream/<app>`. */
  upstreamLinks: string[];
  /** Content of `/opt/<app>/config/proxy-config-container.sh`. */
  serviceScript: string | null;
  /** The config container `mup-proxy-configure-<app>` is running. */
  serviceRunning: boolean;
  /** The proxy container `mup-nginx-proxy` is running. */
  proxyRunning: boolean;
}

/** What the config asks for, computed locally. */
export interface DesiredProxyFiles {
  /** The content of every domain's vhost files (`location` null = no `_location` file). */
  vhost: { server: string; location: string | null };
  /** sha256 of the local certificate and key; `applyProxySync` reads the files again to upload them. */
  certs: { crt: string; key: string } | null;
  lb: boolean;
  /** What `service-configure.sh` writes into `proxy-config-container.sh` (load balancing only). */
  serviceScript: string | null;
}

/** How load balancing changes on a server: from the config and the server's `_upstream` links. */
export type LbTransition = 'none' | 'enable' | 'disable' | 'keep';

/**
 * - `vhost`: `nginx-config.sh`; `certs`: cleanup, upload, links; `lb-remove`: upstream file,
 *   links and the config container go.
 * - `lb-enable`: the upstream file in MUP's form and the links; `lb-links`: only the links
 *   (the domains changed, the content is the upstream controller's); `service`: the config
 *   container (`service-configure.sh`).
 */
export type BeforeStep = 'vhost' | 'certs' | 'lb-remove';
export type AfterStep = 'lb-enable' | 'lb-links' | 'service';

export interface ProxySyncPlan {
  before: BeforeStep[];
  after: AfterStep[];
  /** Regenerate the nginx config after the steps of that phase (otherwise a reload, when any step ran). */
  regenerate: { before: boolean; after: boolean };
  lbTransition: LbTransition;
  /** Human-readable, for the output. */
  changes: string[];
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The file of a config key, as bytes; a failure names the key and the path. */
function readBytes(key: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new CometError(`Cannot read ${key} (${path}): ${(err as Error).message}`);
  }
}

/**
 * The content `service-configure.sh` writes into `proxy-config-container.sh`: its `NEW_CONTENT`
 * heredoc as bash expands it (`<<-` strips leading tabs; an unquoted heredoc joins lines ending
 * in a backslash and unescapes `\$`, `` \` `` and `\\`), without trailing newlines (`$(…)`), plus
 * the newline of `echo`. The env values (domains, ports) hold no `$`; if one did, the script
 * would differ from this every time and the config container would just be refreshed.
 */
export async function serviceScriptContent(c: NormalizedConfig): Promise<string> {
  const script = await renderServiceConfigureSh(c);
  const open = 'NEW_CONTENT="$(cat <<-CONFIG_EOT\n';
  const start = script.indexOf(open);
  const end = script.indexOf('\nCONFIG_EOT\n)"', start);
  if (start < 0 || end < 0) throw new CometError('Unexpected service-configure.sh: no NEW_CONTENT heredoc.');
  const body = script
    .slice(start + open.length, end + 1)
    .split('\n')
    .map((line) => line.replace(/^\t+/, ''))
    .join('\n')
    .replace(/\\([$`\\\n])/g, (_m, ch: string) => (ch === '\n' ? '' : ch));
  return `${body.replace(/\n+$/, '')}\n`;
}

/**
 * The app's proxy files as the config describes them.
 *
 * @throws CometError naming the config key and the path of a file that cannot be read
 *   (`proxy.nginxServerConfig`, `proxy.nginxLocationConfig`, `proxy.ssl.crt`, `proxy.ssl.key`),
 *   so a deploy fails before the build.
 */
export async function desiredProxyFiles(c: NormalizedConfig, basePath: string): Promise<DesiredProxyFiles> {
  const vhost = vhostContent(c, basePath);
  const files = customCertFiles(c, basePath);
  const certs = files ? { crt: sha256(readBytes('proxy.ssl.crt', files.crt)), key: sha256(readBytes('proxy.ssl.key', files.key)) } : null;
  const lb = !!c.proxy?.loadBalancing;
  return { vhost, certs, lb, serviceScript: lb ? await serviceScriptContent(c) : null };
}

/** Parses the output of `proxy-state.sh` for `domains` (the keys use each domain's index). */
export function parseProxyState(stdout: string, domains: string[]): ProxyFileState {
  const kv = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  if (!kv.has('proxyRunning')) throw new CometError(`Unexpected output of the proxy state check:\n${stdout.slice(-2000)}`);
  const hash = (k: string) => {
    const v = kv.get(k);
    return v === undefined || v === '-' ? null : v;
  };
  const text = (k: string) => {
    const v = hash(k);
    return v === null ? null : Buffer.from(v, 'base64').toString('utf8');
  };
  const list = (k: string) => (text(k) ?? '').split('\n').filter((s) => s !== '');
  const perDomain = (prefix: string) => Object.fromEntries(domains.map((d, i) => [d, hash(`${prefix}.${i}`)]));
  return {
    vhost: perDomain('vhost'),
    location: perDomain('location'),
    cert: { crt: hash('crt'), key: hash('key'), linkedDomains: list('certlinks') },
    upstream: text('upstream'),
    upstreamLinks: list('upstreamlinks'),
    serviceScript: text('service'),
    serviceRunning: kv.get('serviceRunning') === '1',
    proxyRunning: kv.get('proxyRunning') === '1',
  };
}

/** Reads the app's proxy files on one server with one script (`proxy-state.sh`). */
export async function readProxyFileState(conn: SshConnection, c: NormalizedConfig): Promise<ProxyFileState> {
  const domains = proxyDomains(c);
  const script = await cometScript('proxy-state.sh', { appName: c.app.name, proxyName: PROXY_NAME, domains });
  const r = await conn.runScriptOrThrow(script, 'Reading the proxy files');
  return parseProxyState(r.stdout, domains);
}

const sameSet = (a: string[], b: string[]) => a.length === new Set(b).size && new Set([...a, ...b]).size === a.length;

/** Compares one file: null = missing on that side. Returns the change, or null when equal. */
function fileChange(current: string | null, desired: string | null): 'created' | 'updated' | 'removed' | null {
  if (current === desired) return null;
  if (current === null) return 'created';
  return desired === null ? 'removed' : 'updated';
}

/**
 * What to change on a proxy server so its files match `desired` (pure). Only differences become
 * steps; a server that matches gets an empty plan, so the deploy is not delayed.
 *
 * Load balancing counts as on when the server has `_upstream` links of the app. Without load
 * balancing in the config, a leftover upstream file or config container is removed too: the
 * config container carries the app's VIRTUAL_HOST and nginx would also route to it.
 */
export function planProxySync(desired: DesiredProxyFiles, current: ProxyFileState, domains: string[]): ProxySyncPlan {
  const before: BeforeStep[] = [];
  const after: AfterStep[] = [];
  const changes: string[] = [];
  const regenerate = { before: false, after: false };

  const serverHash = sha256(desired.vhost.server);
  const locationHash = desired.vhost.location === null ? null : sha256(desired.vhost.location);
  for (const d of domains) {
    for (const [file, cur, want] of [
      [d, current.vhost[d] ?? null, serverHash],
      [`${d}_location`, current.location[d] ?? null, locationHash],
    ] as const) {
      const change = fileChange(cur, want);
      if (!change) continue;
      if (!before.includes('vhost')) before.push('vhost');
      if (change !== 'updated') regenerate.before = true;
      changes.push(`vhost.d/${file} ${change}`);
    }
  }

  const cert = current.cert;
  if (desired.certs) {
    if (cert.crt !== desired.certs.crt || cert.key !== desired.certs.key || !sameSet(cert.linkedDomains, domains)) {
      before.push('certs');
      regenerate.before = true;
      changes.push(cert.crt === null ? 'custom certificate uploaded' : 'custom certificate updated');
    }
  } else if (cert.crt !== null || cert.key !== null || cert.linkedDomains.length > 0) {
    before.push('certs');
    regenerate.before = true;
    changes.push('custom certificate removed');
  }

  const linked = current.upstreamLinks.length > 0;
  const leftover = linked || current.upstream !== null || current.serviceScript !== null || current.serviceRunning;
  const lbTransition: LbTransition = desired.lb ? (linked ? 'keep' : 'enable') : leftover ? 'disable' : 'none';
  if (lbTransition === 'enable') {
    after.push('lb-enable', 'service');
    regenerate.after = true;
    changes.push('load balancing enabled');
  } else if (lbTransition === 'disable') {
    before.push('lb-remove');
    regenerate.before = true;
    changes.push('load balancing disabled');
  } else if (lbTransition === 'keep') {
    if (!sameSet(current.upstreamLinks, domains)) {
      after.push('lb-links');
      regenerate.after = true;
      changes.push('upstream links updated');
    }
    if (current.serviceScript !== desired.serviceScript || !current.serviceRunning) {
      after.push('service');
      regenerate.after = true;
      changes.push(current.serviceScript !== desired.serviceScript ? 'load balancing config container updated' : 'load balancing config container started');
    }
  }
  return { before, after, regenerate, lbTransition, changes };
}

/** Runs `proxy-upstream.sh` in one of its modes (see the script). */
async function upstreamScript(conn: SshConnection, c: NormalizedConfig, mode: 'write' | 'remove' | 'links', content: string | null, out?: ExecOptions): Promise<void> {
  const script = await cometScript('proxy-upstream.sh', {
    appName: c.app.name,
    proxyName: PROXY_NAME,
    domains: proxyDomains(c),
    mode,
    content64: content === null ? '' : Buffer.from(content, 'utf8').toString('base64'),
  });
  await conn.runScriptOrThrow(script, mode === 'remove' ? 'Removing the nginx upstream' : 'Configuring the nginx upstream', out);
}

/**
 * Writes `upstream/<app>` with `content` and links every domain to it, then reloads nginx; null
 * removes the file and the app's links without a reload (the caller regenerates the config).
 */
export function writeUpstreamFile(conn: SshConnection, c: NormalizedConfig, content: string | null, out?: ExecOptions): Promise<void> {
  return upstreamScript(conn, c, content === null ? 'remove' : 'write', content, out);
}

/** Regenerates the nginx config once inside `mup-nginx-proxy`, checks it and reloads nginx. */
export async function regenerateNginx(conn: SshConnection, out?: ExecOptions): Promise<void> {
  await conn.runScriptOrThrow(await cometScript('proxy-regenerate.sh', {}), 'Regenerating the nginx config', out);
}

/** Checks the nginx config and reloads nginx (a changed file that was already included). */
async function reloadNginx(conn: SshConnection, out?: ExecOptions): Promise<void> {
  await conn.runScriptOrThrow(await cometScript('proxy-reload.sh', {}), 'Reloading nginx', out);
}

/** MUP setup's certificate steps: cleanup, then (with a custom certificate) upload and links. */
async function syncCerts(conn: SshConnection, c: NormalizedConfig, basePath: string, out?: ExecOptions): Promise<void> {
  await conn.runScriptOrThrow(await renderSslCleanupSh(c), 'Cleaning Up SSL Certificates', out);
  const files = customCertFiles(c, basePath);
  if (!files) return;
  const dir = `/opt/${c.app.name}/config`;
  await conn.writeFile(`${dir}/bundle.crt`, readConfigFile('proxy.ssl.crt', files.crt));
  // Over SFTP, so the key never appears in a command or a script.
  await conn.writeFile(`${dir}/private.key`, readConfigFile('proxy.ssl.key', files.key), 0o600);
  await conn.runScriptOrThrow(await renderSslSetupSh(c), 'Setup SSL Certificates for Domains', out);
}

/** Removes the load balancing config container and its script (MUP leaves both behind). */
async function removeConfigContainer(conn: SshConnection, c: NormalizedConfig, out?: ExecOptions): Promise<void> {
  const name = shArg(`mup-proxy-configure-${c.app.name}`);
  const script = shArg(`/opt/${c.app.name}/config/proxy-config-container.sh`);
  const r = await conn.exec(`sudo docker rm -f ${name} > /dev/null 2>&1 || true; rm -f ${script}`, out);
  if (r.code !== 0) throw new CometError(`[${conn.name}] Removing the load balancing config container failed (exit code ${r.code}): ${r.stderr.trim()}`);
}

/**
 * Runs the steps of one phase of `plan` on one proxy server, then regenerates the nginx config
 * (when the plan says so) or reloads nginx. A phase without steps does nothing.
 */
export async function applyProxySync(
  conn: SshConnection,
  c: NormalizedConfig,
  basePath: string,
  plan: ProxySyncPlan,
  phase: 'before' | 'after',
  out?: ExecOptions,
): Promise<void> {
  const steps: Array<BeforeStep | AfterStep> = phase === 'before' ? plan.before : plan.after;
  if (steps.length === 0) return;
  for (const step of steps) {
    switch (step) {
      case 'vhost':
        await conn.runScriptOrThrow(await renderNginxConfigSh(c, basePath), 'Pushing Nginx Config', out);
        break;
      case 'certs':
        await syncCerts(conn, c, basePath, out);
        break;
      case 'lb-remove':
        await writeUpstreamFile(conn, c, null, out);
        await removeConfigContainer(conn, c, out);
        break;
      case 'lb-enable':
        await writeUpstreamFile(conn, c, formatUpstream(c, desiredEntries(c)), out);
        break;
      case 'lb-links':
        await upstreamScript(conn, c, 'links', null, out);
        break;
      case 'service':
        await conn.runScriptOrThrow(await renderServiceConfigureSh(c), 'Configure Proxy', out);
        break;
    }
  }
  if (plan.regenerate[phase]) await regenerateNginx(conn, out);
  else await reloadNginx(conn, out);
}
