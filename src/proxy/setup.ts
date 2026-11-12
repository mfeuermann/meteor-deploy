/**
 * The shared proxy's own commands (`proxy setup`, `start`, `stop`, `reconfig-shared`, `status`)
 * and the proxy part of `setup` (MUP `post.setup`), as MUP 1.5.11 runs them (ref. §3.6) with
 * two differences (proxy spec §4.1):
 *
 * - The proxy containers are recreated only when one of the files they are created from changed
 *   or they do not run (`proxyInputsDigest` before and after the upload). `proxy start` always
 *   recreates them, as in MUP. Without a restart the nginx config is regenerated, so new or
 *   removed files of the app take effect.
 * - The app's upstream file keeps the `down` marks of drained servers (§4.4).
 *
 * Each command takes the deploy lock of every app server (§4.6), so it never runs during a
 * deploy of this app. A server where the app is not set up yet has nothing to lock.
 *
 * With load balancing, `proxy setup` writes the upstream only when its servers and ports are the
 * config's already (MUP's file, with the down marks kept). Turning load balancing on, or moving
 * servers to another port or address, is left to the next deploy, which does it once each
 * server runs the config: the running containers do not listen where the new upstream points.
 */
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { lockServers, releaseServers, type PipelineDeps } from '../deploy/pipeline.js';
import { verboseOutput } from '../output/lines.js';
import { runOnServers } from '../remote/on-servers.js';
import { acquireLock, cometScript, readLock, releaseLock } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import {
  LB_OFF_WITHOUT_BACKEND,
  loadBalancingHosts,
  PROXY_DIR,
  PROXY_NAME,
  proxyDomains,
  proxyServers,
  readNginxTmpl,
  renderCleanupTemplateSh,
  renderNginxConfigSh,
  renderProxySetupSh,
  renderProxyStartScript,
  renderProxyStartSh,
  renderProxyStopSh,
  renderServiceConfigureSh,
  renderSharedFiles,
} from './render.js';
import {
  desiredProxyFiles,
  planProxySync,
  readProxyFileState,
  readRemote,
  regenerateNginx,
  removeLoadBalancing,
  startedNginxDefault,
  syncCerts,
  takeProxyDir,
  writeUpstreamFile,
} from './sync.js';
import { desiredEntries, formatUpstream, parseUpstream } from './upstream.js';

/** The lock functions the proxy commands use (tests replace them). */
export type ProxyLockDeps = Pick<PipelineDeps, 'acquireLock' | 'releaseLock' | 'readLock'>;
const LOCK_DEPS: ProxyLockDeps = { acquireLock, releaseLock, readLock };

type ServerStep = (conn: SshConnection, server: string) => Promise<string | void>;

/** The `proxy` section, or MUP's error when there is none. */
function requireProxy(ctx: CommandContext): Record<string, any> {
  if (!ctx.config.proxy) throw new CometError('The config has no "proxy" section.', { hint: 'Add a "proxy" section to the config (see the MUP docs).' });
  return ctx.config.proxy;
}

/**
 * Runs `fn` while holding the deploy lock of every app server, whatever `--servers` selects:
 * the proxy is shared by all app servers' traffic (spec §4.6).
 */
async function withAppLock<T>(ctx: CommandContext, command: string, d: ProxyLockDeps, fn: () => Promise<T>): Promise<T> {
  const locked = await lockServers(ctx, Object.keys(ctx.config.app.servers ?? {}), command, d, { skipNotSetUp: true });
  try {
    return await fn();
  } finally {
    await releaseServers(ctx, locked, d);
  }
}

/** Like `runOnServers`, but one server after the other, stopping at the first failure (MUP `series: true`). */
async function runSerially(ctx: CommandContext, servers: string[], step: string, fn: ServerStep): Promise<void> {
  for (const s of servers) {
    ctx.reporter.server(s, step, 'running');
    try {
      const detail = await fn(await ctx.ssh.get(s), s);
      ctx.reporter.server(s, step, 'ok', detail || undefined);
    } catch (err) {
      ctx.reporter.server(s, step, 'failed', (err as Error)?.message ?? String(err));
      throw new CometError(`${step} failed on ${s}: ${(err as Error)?.message ?? err}`);
    }
  }
}

/** What the proxy containers are created from, as one hash, and whether both run. */
export interface ProxyInputs {
  digest: string;
  running: boolean;
}

/**
 * One sha256 over `start.sh`, `shared-config.sh`, `env.list`, `env_letsencrypt.list`,
 * `nginx-default.conf`, `nginx.tmpl` and `nginx-shared.tmpl` (a missing file counts as "-"),
 * and whether `mup-nginx-proxy` and `mup-nginx-proxy-letsencrypt` both run.
 */
export async function proxyInputsDigest(conn: SshConnection): Promise<ProxyInputs> {
  const r = await conn.runScriptOrThrow(await cometScript('proxy-inputs.sh', {}), 'Reading the proxy files');
  const digest = /^digest=(\S+)$/m.exec(r.stdout)?.[1];
  if (!digest) throw new CometError(`[${conn.name}] Unexpected output of the proxy file check:\n${r.stdout.slice(-2000)}`);
  return { digest, running: /^running=1$/m.test(r.stdout) };
}

/**
 * `proxy.start`: on each server, recreates the proxy containers with `proxy-start.sh` when
 * `force`, when they do not both run, or when the inputs digest differs from `before[server]`
 * (taken before this command uploaded anything). Otherwise it regenerates the nginx config and
 * prints that the proxy is up to date.
 */
async function runProxyStart(ctx: CommandContext, servers: string[], o: { force: boolean; before?: Record<string, ProxyInputs>; parallel: boolean }): Promise<void> {
  await ctx.runner.run('proxy.start', async () => {
    const script = await renderProxyStartScript();
    const one: ServerStep = async (conn, s) => {
      const out = verboseOutput(ctx.reporter, s);
      if (!o.force) {
        const now = await proxyInputsDigest(conn);
        const was = o.before?.[s];
        if (now.running && was !== undefined && was.digest === now.digest) {
          await regenerateNginx(conn, out);
          ctx.reporter.info(`[${s}] proxy up to date`);
          return 'not restarted';
        }
      }
      await conn.runScriptOrThrow(script, 'Start proxy', out);
      return 'started';
    };
    await ctx.reporter.phase('Proxy start', () => (o.parallel ? runOnServers(ctx, servers, 'proxy start', one) : runSerially(ctx, servers, 'proxy start', one)));
  });
}

/**
 * `proxy setup` (and the proxy part of `setup`): MUP's setup steps on every proxy server in
 * parallel, then `proxy.start` when needed, then the load balancing config container (MUP
 * `post.proxy.setup`). Everything local is read first, so a missing file fails before any
 * server changes.
 */
export async function proxySetup(ctx: CommandContext, d: ProxyLockDeps = LOCK_DEPS): Promise<void> {
  const p = requireProxy(ctx);
  const c = ctx.config;
  ctx.runner.refuseHooks(['proxy.setup', 'proxy.start']);
  const servers = proxyServers(c, ctx.serverFilter);
  // A file the config names but that cannot be read stops the command before any server is asked.
  if (p.shared) await renderSharedFiles(c, { basePath: ctx.basePath, cwd: ctx.cwd });
  const upstreamPath = `${PROXY_DIR}/upstream/${c.app.name}`;
  await withAppLock(ctx, 'proxy setup', d, async () => {
    const appServers = new Set(Object.keys(c.app.servers ?? {}));
    if (!p.loadBalancing && proxyServers(c, null).some((s) => !appServers.has(s))) {
      const linked = await Promise.all(servers.map(async (s) => (await readRemote(await ctx.ssh.get(s), upstreamPath)) !== null));
      if (linked.some(Boolean)) throw new CometError(LB_OFF_WITHOUT_BACKEND);
    }
    const before: Record<string, ProxyInputs> = {};
    /** Proxy servers whose upstream exists (load balancing runs there): they get the config container. */
    const balanced = new Set<string>();
    await ctx.runner.run('proxy.setup', async () => {
      await desiredProxyFiles(c, ctx.basePath);
      const setupSh = await renderProxySetupSh(c);
      const startSh = await renderProxyStartSh(c);
      const tmpl = await readNginxTmpl();
      const nginxConfigSh = await renderNginxConfigSh(c, ctx.basePath);
      await ctx.reporter.phase('Proxy setup', () =>
        runOnServers(ctx, servers, 'proxy setup', async (conn, s) => {
          const out = verboseOutput(ctx.reporter, s);
          await conn.runScriptOrThrow(setupSh, 'Setup Environment', out);
          before[s] = await proxyInputsDigest(conn);
          await conn.writeFile(`${PROXY_DIR}/config/start.sh`, startSh);
          await conn.writeFile(`${PROXY_DIR}/config/nginx.tmpl`, tmpl);
          await conn.runScriptOrThrow(nginxConfigSh, 'Pushing Nginx Config', out);
          await syncCerts(conn, c, ctx.basePath, out);
          if (p.loadBalancing) {
            const current = await readRemote(conn, upstreamPath);
            if (current === null) {
              ctx.reporter.info(`[${s}] load balancing is turned on by the next "comet-deploy deploy", once every server runs with it`);
              return;
            }
            balanced.add(s);
            const entries = parseUpstream(current);
            const want = desiredEntries(c);
            const same = entries.length === want.length && want.every((w) => entries.some((e) => e.host === w.host && e.port === w.port));
            if (!same) {
              ctx.reporter.info(`[${s}] the upstream keeps its servers and ports: the next "comet-deploy deploy" moves each server once it runs the config`);
              return;
            }
            // MUP's upstream, but a server drained by an unfinished deploy stays down (spec §4.1).
            const down = new Set(entries.filter((e) => e.down).map((e) => e.host));
            await writeUpstreamFile(conn, c, formatUpstream(c, want.map((e) => ({ ...e, down: down.has(e.host) }))), out);
          } else {
            await removeLoadBalancing(conn, c, out);
          }
        }),
      );
    });
    await runProxyStart(ctx, servers, { force: false, before, parallel: true });
    if (p.loadBalancing && balanced.size > 0) {
      const script = await renderServiceConfigureSh(c);
      await runOnServers(ctx, servers.filter((s) => balanced.has(s)), 'proxy load balancing', async (conn, s) => {
        await conn.runScriptOrThrow(script, 'Configure Proxy', verboseOutput(ctx.reporter, s));
      });
    }
  });
}

/** `proxy start`: recreates the proxy containers, server by server (`force: true` for the command). */
export async function proxyStart(ctx: CommandContext, o: { force: boolean }, d: ProxyLockDeps = LOCK_DEPS): Promise<void> {
  requireProxy(ctx);
  ctx.runner.refuseHooks(['proxy.start']);
  const servers = proxyServers(ctx.config, ctx.serverFilter);
  await withAppLock(ctx, 'proxy start', d, () => runProxyStart(ctx, servers, { force: o.force, parallel: false }));
}

/** `proxy stop`: removes both proxy containers on every proxy server. */
export async function proxyStop(ctx: CommandContext, d: ProxyLockDeps = LOCK_DEPS): Promise<void> {
  requireProxy(ctx);
  ctx.runner.refuseHooks(['proxy.stop']);
  const servers = proxyServers(ctx.config, ctx.serverFilter);
  await withAppLock(ctx, 'proxy stop', d, () =>
    ctx.runner.run('proxy.stop', async () => {
      const script = await renderProxyStopSh();
      await runOnServers(ctx, servers, 'proxy stop', async (conn, s) => {
        await conn.runScriptOrThrow(script, 'Stop proxy', verboseOutput(ctx.reporter, s));
      });
    }),
  );
}

/**
 * `proxy reconfig-shared`: uploads the shared settings server by server, then `proxy.start` when
 * they changed. `nginx-default.conf` is kept when it already has the effect of the new one (the
 * line `start.sh` appended does not count as a change).
 */
export async function proxyReconfigShared(ctx: CommandContext, d: ProxyLockDeps = LOCK_DEPS): Promise<void> {
  const p = requireProxy(ctx);
  const c = ctx.config;
  ctx.runner.refuseHooks(['proxy.reconfig-shared', 'proxy.start']);
  const shared = (p.shared ?? {}) as Record<string, unknown>;
  const servers = proxyServers(c, ctx.serverFilter);
  await withAppLock(ctx, 'proxy reconfig-shared', d, async () => {
    const before: Record<string, ProxyInputs> = {};
    await ctx.runner.run('proxy.reconfig-shared', async () => {
      ctx.reporter.info('The shared settings affect all apps using this reverse proxy.');
      if (Object.keys(shared).length === 0) ctx.reporter.info('No shared config properties are set. Resetting proxy to defaults.');
      const f = await renderSharedFiles(c, { basePath: ctx.basePath, cwd: ctx.cwd });
      const cleanupSh = await renderCleanupTemplateSh();
      const dir = `${PROXY_DIR}/config`;
      await runSerially(ctx, servers, 'proxy reconfig-shared', async (conn, s) => {
        const out = verboseOutput(ctx.reporter, s);
        before[s] = await proxyInputsDigest(conn);
        await takeProxyDir(conn, out);
        const keepConf =
          (await readRemote(conn, `${dir}/shared-config.sh`)) === f.sharedConfigSh &&
          (await readRemote(conn, `${dir}/nginx-default.conf`)) === startedNginxDefault(f.nginxDefaultConf, shared.clientUploadLimit);
        await conn.writeFile(`${dir}/shared-config.sh`, f.sharedConfigSh);
        await conn.writeFile(`${dir}/env.list`, f.envList, 0o600);
        await conn.writeFile(`${dir}/env_letsencrypt.list`, f.envLetsEncryptList, 0o600);
        if (!keepConf) await conn.writeFile(`${dir}/nginx-default.conf`, f.nginxDefaultConf);
        if (f.template !== null) await conn.writeFile(`${dir}/nginx-shared.tmpl`, f.template);
        else await conn.runScriptOrThrow(cleanupSh, 'Cleanup Template', out);
      });
    });
    await runProxyStart(ctx, servers, { force: false, before, parallel: false });
  });
}

/** One proxy server in `proxy status`. */
export interface ProxyStatusRow {
  server: string;
  nginx: string;
  letsEncrypt: string;
  httpPort?: string;
  httpsPort?: string;
  /** `<domain>.chain.pem` → expiry date (MUP's check). */
  certificates: Record<string, string>;
  /** App servers marked down in the app's upstream file (a drain that was not undone). */
  downServers: string[];
  /** The app's proxy files that differ from the config (`planProxySync`). */
  outOfSync: string[];
}

/** Parses `proxy-status.sh`; `outOfSync` is filled in by the caller. */
export function parseProxyStatus(server: string, stdout: string, hostToServer: Map<string, string>): ProxyStatusRow {
  const row: ProxyStatusRow = { server, nginx: 'Stopped', letsEncrypt: 'Stopped', certificates: {}, downServers: [], outOfSync: [] };
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'nginx') row.nginx = value || 'Stopped';
    else if (key === 'le') row.letsEncrypt = value || 'Stopped';
    else if (key === 'http' && value) row.httpPort = value;
    else if (key === 'https' && value) row.httpsPort = value;
    else if (key === 'cert') {
      const sp = value.indexOf(' ');
      if (sp > 0) row.certificates[value.slice(0, sp)] = value.slice(sp + 1).trim();
      else if (value) row.certificates[value] = '';
    } else if (key === 'upstream' && value !== '-') {
      const entries = parseUpstream(Buffer.from(value, 'base64').toString('utf8'));
      row.downServers = entries.filter((e) => e.down).map((e) => hostToServer.get(e.host) ?? e.host);
    }
  }
  return row;
}

/** `proxy.status`: the state of the shared proxy on every proxy server. */
export async function proxyStatus(ctx: CommandContext): Promise<ProxyStatusRow[]> {
  requireProxy(ctx);
  const c = ctx.config;
  const script = await cometScript('proxy-status.sh', { appName: c.app.name });
  const names = Object.keys(c.app.servers ?? {});
  const hosts = loadBalancingHosts(c);
  const hostToServer = new Map(hosts.map((h, i) => [h, names[i]]));
  const desired = await desiredProxyFiles(c, ctx.basePath).catch((err: Error) => err);
  return Promise.all(
    proxyServers(c, ctx.serverFilter).map(async (s): Promise<ProxyStatusRow> => {
      try {
        const conn = await ctx.ssh.get(s);
        // The exit code is not checked: whatever the script printed is parsed.
        const row = parseProxyStatus(s, (await conn.runScript(script)).stdout, hostToServer);
        try {
          if (desired instanceof Error) throw desired;
          row.outOfSync = planProxySync(desired, await readProxyFileState(conn, c), proxyDomains(c)).changes;
        } catch (err) {
          row.outOfSync = [`cannot compare with the config (${(err as Error).message.split('\n')[0]})`];
        }
        return row;
      } catch (err) {
        ctx.reporter.warn(`Could not read the proxy status of "${s}": ${(err as Error).message}`);
        return { server: s, nginx: 'unreachable', letsEncrypt: 'unreachable', certificates: {}, downServers: [], outOfSync: [] };
      }
    }),
  );
}

/** MUP's "=> Reverse Proxy Status" block, plus drained servers and files out of sync. */
export function formatProxyStatus(rows: ProxyStatusRow[]): string {
  const lines = ['', '=> Reverse Proxy Status'];
  for (const r of rows) {
    lines.push(` - ${r.server}:`, '   - NGINX:', `     - Status: ${r.nginx}`);
    if (r.httpPort || r.httpsPort) {
      lines.push('     - Ports:');
      if (r.httpsPort) lines.push(`       - HTTPS: ${r.httpsPort}`);
      if (r.httpPort) lines.push(`       - HTTP: ${r.httpPort}`);
    }
    lines.push("   - Let's Encrypt", `     - Status: ${r.letsEncrypt}`);
    const certs = Object.entries(r.certificates);
    if (certs.length) {
      lines.push('     - Certificates');
      for (const [name, date] of certs) lines.push(`       - ${name}: ${date}`);
    }
    if (r.downServers.length) {
      const one = r.downServers.length === 1;
      lines.push(`   - Drained: ${r.downServers.join(', ')} (run "comet-deploy restart --servers ${r.downServers.join(',')}" once ${one ? 'it is' : 'they are'} healthy)`);
    }
    if (r.outOfSync.length) {
      // proxy setup leaves turning on load balancing to a deploy (see above).
      const fix = r.outOfSync.includes('load balancing enabled') ? 'comet-deploy deploy' : 'comet-deploy proxy setup';
      lines.push(`   - Out of sync: ${r.outOfSync.join(', ')} (run "${fix}" to sync)`);
    }
  }
  return lines.join('\n');
}

/** `proxy nginx-config`: the generated nginx config of every proxy server (MUP layout). */
export async function proxyNginxConfig(ctx: CommandContext): Promise<void> {
  requireProxy(ctx);
  const servers = proxyServers(ctx.config, ctx.serverFilter);
  const outputs = await Promise.all(
    servers.map(async (s) => (await (await ctx.ssh.get(s)).exec(`sudo docker exec ${PROXY_NAME} cat /etc/nginx/conf.d/default.conf`)).stdout),
  );
  servers.forEach((s, i) => ctx.reporter.info(`===== ${ctx.config.servers[s]?.host ?? s} ======\n${outputs[i]}`));
}
