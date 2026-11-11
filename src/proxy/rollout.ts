/**
 * The proxy part of `deploy`, `reconfig`, `restart` and `rollback` (proxy spec §4.2–§4.4, §4.6).
 * A pipeline creates one `ProxyRollout` before it locks anything and drives it around its
 * activation:
 *
 *  1. `createProxyRollout` (before the build or the lock): reads the files the config names
 *     (deploy and reconfig), so a missing one fails before anything else, and the state of every
 *     proxy server. A proxy server that cannot be read or whose proxy does not run stops the
 *     command here, before anything changed.
 *  2. `prepare` (after the lock): reads the state again and, for deploy and reconfig, brings the
 *     app's proxy files in line before the first server is activated (the `before` part of the
 *     sync). With load balancing it sets up the upstream controller from the current upstream.
 *  3. `activate` (per server, inside the strategy): picks how the container is replaced. With
 *     load balancing and a strategy other than parallel it takes the server out of the upstream
 *     first and puts it back once it is healthy again; otherwise the zero-downtime switch is used
 *     when the config allows it.
 *  4. `finish` (in the pipeline's `finally`, also after an abort): the `after` part of the sync
 *     (enabling load balancing only once every app server runs the new config), the final upstream
 *     with the servers that did not end healthy kept down, and the warnings for the summary.
 */
import type { CometOptions, NormalizedConfig } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import type { ActivationResult } from '../deploy/activate.js';
import { zeroDowntimeBlocker, type SwitchMode } from '../deploy/zero-downtime.js';
import { containerName } from '../core/naming.js';
import { verboseOutput } from '../output/lines.js';
import { shArg } from '../remote/ops.js';
import type { SshConnection } from '../ssh/connection.js';
import { PROXY_NOT_SET_UP, proxyDomains, proxyServers } from './render.js';
import {
  applyProxySync,
  desiredProxyFiles,
  planProxySync,
  readProxyFileState,
  sharedSettingsDrift,
  writeUpstreamFile,
  type DesiredProxyFiles,
  type LbTransition,
  type ProxyFileState,
  type ProxySyncPlan,
} from './sync.js';
import { parseUpstream, UpstreamController, type UpstreamApply, type UpstreamEntry } from './upstream.js';

/** The commands that run a rollout behind the proxy. */
export type RolloutAction = 'deploy' | 'reconfig' | 'rollback' | 'restart';

export interface ProxyRollout {
  /** After the lock: deploy/reconfig sync the `before` part on every proxy server; load balancing sets up the upstream controller. */
  prepare(): Promise<void>;
  /** Wraps one server's activation: picks the SwitchMode, drains (load balancing), runs, marks the server healthy or keeps it down. */
  activate(server: string, run: (mode: SwitchMode) => Promise<ActivationResult>): Promise<ActivationResult>;
  /** After the strategy (also after an abort): the `after` part of the sync and the final upstream. Returns warnings for the summary; never throws. */
  finish(results: ActivationResult[]): Promise<string[]>;
}

/** What `finish` and `activate` use of `UpstreamController`. */
export type UpstreamControl = Pick<UpstreamController, 'drain' | 'healthy' | 'finalize' | 'downServers' | 'failures'>;

/** The proxy I/O of a rollout; the defaults use SSH (`PROXY_ROLLOUT_DEPS`), tests replace them. */
export interface ProxyRolloutDeps {
  readProxyFileState: (conn: SshConnection, c: NormalizedConfig) => Promise<ProxyFileState>;
  applyProxySync: typeof applyProxySync;
  writeUpstreamFile: typeof writeUpstreamFile;
  sharedSettingsDrift: typeof sharedSettingsDrift;
  upstreamController: (c: NormalizedConfig, current: UpstreamEntry[], apply: UpstreamApply) => UpstreamControl;
  /** Whether the app's running container publishes a host port (false when there is none). */
  publishesHostPort: (conn: SshConnection, c: NormalizedConfig) => Promise<boolean>;
}

/** `docker inspect` of the app container's port bindings: any binding means a published host port. */
async function publishesHostPort(conn: SshConnection, c: NormalizedConfig): Promise<boolean> {
  const r = await conn.exec(`sudo docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}' ${shArg(containerName(c))} 2>/dev/null`);
  return r.code === 0 && r.stdout.trim() !== '';
}

export const PROXY_ROLLOUT_DEPS: ProxyRolloutDeps = {
  readProxyFileState,
  applyProxySync,
  writeUpstreamFile,
  sharedSettingsDrift,
  upstreamController: (c, current, apply) => new UpstreamController(c, current, apply),
  publishesHostPort,
};

/**
 * The servers whose deploy lock a command takes: with load balancing every app server, because
 * the upstream they share is rewritten while one of them restarts (spec §4.6); otherwise the
 * selected app servers.
 */
export function lockTargets(ctx: CommandContext): string[] {
  return ctx.config.proxy?.loadBalancing ? Object.keys(ctx.config.app.servers ?? {}) : ctx.appServers();
}

/**
 * The proxy servers a rollout reads and changes. With load balancing every proxy server: they
 * all route to every app server through the shared upstream. Without it a proxy only routes to
 * the app on its own server, so `--servers` selects the proxies like every MUP command.
 */
export function rolloutProxies(ctx: CommandContext): string[] {
  return proxyServers(ctx.config, ctx.config.proxy?.loadBalancing ? null : ctx.serverFilter);
}

const message = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * The state of every proxy server, read in parallel. Throws one CometError that lists every
 * server that cannot be read or whose proxy does not run.
 */
async function readStates(ctx: CommandContext, d: ProxyRolloutDeps, proxies: string[]): Promise<Map<string, ProxyFileState>> {
  const res = await Promise.allSettled(proxies.map(async (p) => d.readProxyFileState(await ctx.ssh.get(p), ctx.config)));
  const states = new Map<string, ProxyFileState>();
  const errors: string[] = [];
  res.forEach((r, i) => {
    if (r.status === 'rejected') errors.push(`Server "${proxies[i]}": cannot read the proxy files: ${message(r.reason)}`);
    else if (!r.value.proxyRunning) errors.push(`Server "${proxies[i]}": ${PROXY_NOT_SET_UP}`);
    else states.set(proxies[i], r.value);
  });
  if (errors.length) throw new CometError(`The reverse proxy is not ready:\n${errors.map((e) => `  - ${e}`).join('\n')}`, { hint: 'Nothing was changed.' });
  return states;
}

/**
 * The rollout behind the proxy, or null when the config has no `proxy` section. For deploy and
 * reconfig it reads the local files first (a file that cannot be read fails before any server is
 * asked), then the state of every proxy server.
 *
 * @throws CometError for an unreadable file, a proxy server that cannot be read or does not run
 *   the proxy, and for turning off load balancing while the proxy also runs on servers without
 *   the app (those proxies would be left without a backend).
 */
export async function createProxyRollout(
  ctx: CommandContext,
  o: { action: RolloutAction; strategy: CometOptions['strategy'] },
  d: ProxyRolloutDeps = PROXY_ROLLOUT_DEPS,
): Promise<ProxyRollout | null> {
  const c = ctx.config;
  if (!c.proxy) return null;
  const desired = o.action === 'deploy' || o.action === 'reconfig' ? await desiredProxyFiles(c, ctx.basePath) : null;
  const proxies = rolloutProxies(ctx);
  const domains = proxyDomains(c);
  const states = await readStates(ctx, d, proxies);
  if (desired) {
    const appServers = new Set(Object.keys(c.app.servers ?? {}));
    const disabling = proxies.some((p) => planProxySync(desired, states.get(p)!, domains).lbTransition === 'disable');
    if (disabling && proxyServers(c, null).some((p) => !appServers.has(p))) {
      throw new CometError(
        'Turning off loadBalancing while the proxy runs on servers without the app would leave those proxies without a backend. Remove proxy.servers first or keep loadBalancing.',
      );
    }
  }
  return new Rollout(ctx, o, d, { desired, proxies, domains });
}

class Rollout implements ProxyRollout {
  private readonly c: NormalizedConfig;
  /** Why the zero-downtime switch is not used (null: it is), printed once; set again by `prepare`. */
  private blocker: string | null;
  /** Load balancing runs on the proxies (an upstream to keep), as opposed to being enabled by this run. */
  private lbActive: boolean;
  private blockerShown = false;
  /** Whether load-balanced servers are taken out of the upstream while they restart. */
  private readonly drains: boolean;
  private readonly plans = new Map<string, ProxySyncPlan>();
  private controller: UpstreamControl | null = null;
  private prepared = false;
  /** Proxy servers where a step of this rollout failed, for the summary. */
  private readonly failed: Array<{ proxy: string; error: string }> = [];

  constructor(
    private readonly ctx: CommandContext,
    private readonly o: { action: RolloutAction; strategy: CometOptions['strategy'] },
    private readonly d: ProxyRolloutDeps,
    private readonly s: { desired: DesiredProxyFiles | null; proxies: string[]; domains: string[] },
  ) {
    this.c = ctx.config;
    this.lbActive = !!this.c.proxy?.loadBalancing;
    this.blocker = zeroDowntimeBlocker(this.c);
    this.drains =
      !!this.c.proxy?.loadBalancing && this.c.cometDeploy.zeroDowntime !== false && o.strategy !== 'parallel' && Object.keys(this.c.app.servers ?? {}).length > 1;
  }

  /** How load balancing changes on a proxy: from the sync plan, or for rollback/restart from the config and the links. */
  private transition(proxy: string, state: ProxyFileState): LbTransition {
    const plan = this.plans.get(proxy);
    if (plan) return plan.lbTransition;
    return this.c.proxy?.loadBalancing && state.upstreamLinks.length > 0 ? 'keep' : 'none';
  }

  /** `UpstreamApply` over `proxies`: writes in parallel and reports the proxies where that failed. */
  private applyUpstream(proxies: string[]): UpstreamApply {
    return async (content) => {
      const res = await Promise.allSettled(
        proxies.map(async (p) => this.d.writeUpstreamFile(await this.ctx.ssh.get(p), this.c, content, verboseOutput(this.ctx.reporter, p))),
      );
      return { failed: res.flatMap((r, i) => (r.status === 'rejected' ? [{ proxy: proxies[i], error: message(r.reason) }] : [])) };
    };
  }

  async prepare(): Promise<void> {
    const { ctx, c, d } = this;
    const r = ctx.reporter;
    const { desired, proxies, domains } = this.s;
    // Read again: the state read before the lock may be outdated by now.
    const states = await readStates(ctx, d, proxies);
    if (desired) {
      for (const p of proxies) this.plans.set(p, planProxySync(desired, states.get(p)!, domains));
      if (c.proxy?.shared) await this.warnSharedDrift();
      const todo = proxies.filter((p) => this.plans.get(p)!.before.length > 0);
      const res = await Promise.allSettled(
        todo.map(async (p) => {
          const plan = this.plans.get(p)!;
          r.server(p, 'proxy', 'running');
          await d.applyProxySync(await ctx.ssh.get(p), c, ctx.basePath, plan, 'before', verboseOutput(r, p));
          r.server(p, 'proxy', 'ok', plan.changes.join(', '));
        }),
      );
      const failed = res.flatMap((x, i) => (x.status === 'rejected' ? [`  - ${todo[i]}: ${message(x.reason)}`] : []));
      for (const [i, x] of res.entries()) if (x.status === 'rejected') r.server(todo[i], 'proxy', 'failed', message(x.reason));
      if (failed.length) {
        throw new CometError(`Updating the app's proxy files failed:\n${failed.join('\n')}`, { hint: 'The app was not restarted on any server.' });
      }
    }
    const keep = proxies.filter((p) => this.transition(p, states.get(p)!) === 'keep');
    // While load balancing is being enabled nginx still routes to the containers, so the servers
    // can switch without a gap (spec §4.2); the upstream follows in `finish`.
    this.lbActive = !!c.proxy?.loadBalancing && keep.length > 0;
    this.blocker = zeroDowntimeBlocker(c, { loadBalancingActive: this.lbActive });
    if (keep.length) {
      // The proxies share one upstream; the first one's is the starting point (setup writes the same file everywhere).
      const current = parseUpstream(states.get(keep[0])!.upstream ?? '');
      this.controller = d.upstreamController(c, current, this.applyUpstream(keep));
    }
    this.prepared = true;
  }

  /** Warns once when `proxy.shared` differs in effect from the proxy servers' files (spec §4.2). */
  private async warnSharedDrift(): Promise<void> {
    const { ctx, d, c } = this;
    const { proxies } = this.s;
    const drift = await Promise.all(
      proxies.map(async (p) => d.sharedSettingsDrift(await ctx.ssh.get(p), c, { basePath: ctx.basePath, cwd: ctx.cwd }).catch(() => false)),
    );
    const differ = proxies.filter((_, i) => drift[i]);
    if (differ.length === 0) return;
    ctx.reporter.warn(
      `The shared proxy settings (proxy.shared) differ from the ones on ${differ.join(', ')}. A deploy does not apply them, because that restarts the proxy ` +
        'for every app on the server. Run "comet-deploy proxy reconfig-shared" to apply them.',
    );
  }

  async activate(server: string, run: (mode: SwitchMode) => Promise<ActivationResult>): Promise<ActivationResult> {
    if (this.blocker !== null && !this.blockerShown) {
      this.blockerShown = true;
      this.ctx.reporter.info(`Zero-downtime switch not used: ${this.blocker}`);
    }
    let mode: SwitchMode = this.blocker === null ? { kind: 'zero-downtime' } : { kind: 'restart' };
    // Load balancing being enabled: a server whose container already runs with it (an earlier
    // run that did not finish) publishes the port, which a second container cannot bind.
    if (mode.kind === 'zero-downtime' && this.c.proxy?.loadBalancing && !this.lbActive) {
      if (await this.d.publishesHostPort(await this.ctx.ssh.get(server), this.c).catch(() => false)) {
        this.ctx.reporter.info(`[${server}] the running container already publishes the load balancing port: restarting it in place`);
        mode = { kind: 'restart' };
      }
    }
    const ctl = this.controller;
    if (!ctl) return run(mode);
    if (this.drains && (await ctl.drain(server))) this.ctx.reporter.server(server, 'drain', 'ok', 'out of load balancing');
    const result = await run(mode);
    // A reverted server runs its previous version and passed its health check again.
    if (result.status === 'healthy' || result.status === 'reverted') await ctl.healthy(server);
    return result;
  }

  async finish(results: ActivationResult[]): Promise<string[]> {
    const warnings: string[] = [];
    if (!this.prepared) return warnings;
    try {
      await this.syncAfter(results, warnings);
      if (this.controller) {
        const keepDown = new Set(this.controller.downServers());
        await this.controller.finalize(keepDown);
        for (const s of keepDown) {
          warnings.push(`"${s}" stays out of load balancing because it did not end healthy. Once it is healthy, run "comet-deploy restart --servers ${s}" to put it back.`);
        }
        this.failed.push(...this.controller.failures());
      }
    } catch (err) {
      warnings.push(`Finishing the reverse proxy failed: ${message(err)}. Run "comet-deploy proxy setup" to bring it in line.`);
    }
    const byProxy = new Map<string, Set<string>>();
    for (const f of this.failed) (byProxy.get(f.proxy) ?? byProxy.set(f.proxy, new Set()).get(f.proxy)!).add(f.error);
    for (const [p, errors] of byProxy) {
      warnings.push(`Could not update the reverse proxy on "${p}": ${[...errors].join('; ')}. Run "comet-deploy proxy setup" once it is reachable.`);
    }
    return warnings;
  }

  /**
   * The `after` part of the sync on every proxy server that needs it. Load balancing is enabled
   * only when every app server runs the new config: the upstream lists all of them.
   */
  private async syncAfter(results: ActivationResult[], warnings: string[]): Promise<void> {
    const { ctx, c, d } = this;
    const r = ctx.reporter;
    const healthy = new Set(results.filter((x) => x.status === 'healthy').map((x) => x.server));
    const notDeployed = Object.keys(c.app.servers ?? {}).filter((s) => !healthy.has(s));
    const due = [...this.plans].filter(([, plan]) => plan.after.length > 0);
    if (notDeployed.length && due.some(([, plan]) => plan.lbTransition === 'enable')) {
      warnings.push(`loadBalancing was not enabled on the proxies because ${notDeployed.join(', ')} did not deploy; run the deploy again`);
    }
    const todo = due.filter(([, plan]) => plan.lbTransition !== 'enable' || notDeployed.length === 0);
    const res = await Promise.allSettled(
      todo.map(async ([p, plan]) => {
        r.server(p, 'proxy', 'running');
        await d.applyProxySync(await ctx.ssh.get(p), c, ctx.basePath, plan, 'after', verboseOutput(r, p));
        r.server(p, 'proxy', 'ok', plan.after.join(', '));
      }),
    );
    for (const [i, x] of res.entries()) {
      if (x.status === 'fulfilled') continue;
      r.server(todo[i][0], 'proxy', 'failed', message(x.reason));
      this.failed.push({ proxy: todo[i][0], error: message(x.reason) });
    }
  }
}
