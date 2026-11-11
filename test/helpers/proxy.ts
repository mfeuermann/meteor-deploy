/**
 * Fake proxy I/O for the rollout tests: proxy servers whose files already match the config,
 * and `ProxyRolloutDeps` that record what the rollout does (`calls`) instead of using SSH.
 */
import { createHash } from 'node:crypto';
import type { CommandContext } from '../../src/core/context.js';
import { proxyDomains } from '../../src/proxy/render.js';
import type { ProxyRolloutDeps } from '../../src/proxy/rollout.js';
import { desiredProxyFiles, type ProxyFileState } from '../../src/proxy/sync.js';
import { desiredEntries, formatUpstream, parseUpstream, UpstreamController } from '../../src/proxy/upstream.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The state of a proxy server whose files match the config. `lb: 'keep'` adds the app's upstream
 * file (MUP's form, or `upstream`), its links and a running config container; `lb: 'off'` has none.
 */
export async function inSyncState(ctx: CommandContext, o: { lb?: 'keep' | 'off'; upstream?: string } = {}): Promise<ProxyFileState> {
  const c = ctx.config;
  const want = await desiredProxyFiles(c, ctx.basePath);
  const domains = proxyDomains(c);
  const keep = o.lb === 'keep';
  return {
    vhost: Object.fromEntries(domains.map((d) => [d, sha(want.vhost.server)])),
    location: Object.fromEntries(domains.map((d) => [d, want.vhost.location === null ? null : sha(want.vhost.location)])),
    cert: { crt: null, key: null, linkedDomains: [] },
    upstream: keep ? (o.upstream ?? formatUpstream(c, desiredEntries(c))) : null,
    upstreamLinks: keep ? domains : [],
    serviceScript: keep ? want.serviceScript : null,
    serviceRunning: keep,
    proxyRunning: true,
  };
}

/** One upstream write as `upstream:<proxy>:<host>[ down],…`. */
const describeUpstream = (proxy: string, content: string | null) =>
  `upstream:${proxy}:${content === null ? 'removed' : parseUpstream(content).map((e) => `${e.host}${e.down ? ' down' : ''}`).join(',')}`;

/**
 * Proxy deps over fixed states (an `Error` makes reading that server fail). Records into `calls`:
 * `sync:<phase>:<proxy>:<steps>`, `upstream:…`, `shared:<proxy>`, `publishes:<server>` (`o.publishes`
 * lists the servers whose container publishes a host port), and the controller's
 * `drain:<s>`, `healthy:<s>`, `finalize:<keepDown>` (a real `UpstreamController` without the wait).
 */
export function fakeProxyDeps(
  states: Record<string, ProxyFileState | Error>,
  calls: string[],
  o: { failWrite?: string; failAfter?: boolean; drift?: boolean; publishes?: string[] } = {},
): ProxyRolloutDeps {
  return {
    readProxyFileState: async (conn) => {
      const s = states[conn.name];
      if (s instanceof Error) throw s;
      if (!s) throw new Error(`no state for ${conn.name}`);
      return structuredClone(s);
    },
    applyProxySync: async (conn, _c, _basePath, plan, phase) => {
      calls.push(`sync:${phase}:${conn.name}:${(phase === 'before' ? plan.before : plan.after).join('+')}`);
      if (o.failAfter && phase === 'after') throw new Error('nginx -t failed');
    },
    writeUpstreamFile: async (conn, _c, content) => {
      calls.push(describeUpstream(conn.name, content));
      if (conn.name === o.failWrite) throw new Error('connection refused');
    },
    sharedSettingsDrift: async (conn) => {
      calls.push(`shared:${conn.name}`);
      return !!o.drift;
    },
    publishesHostPort: async (conn) => {
      calls.push(`publishes:${conn.name}`);
      return o.publishes?.includes(conn.name) ?? false;
    },
    upstreamController: (c, current, apply) => {
      const real = new UpstreamController(c, current, apply, { waitMs: 0 });
      return {
        drain: (s) => (calls.push(`drain:${s}`), real.drain(s)),
        healthy: (s) => (calls.push(`healthy:${s}`), real.healthy(s)),
        finalize: (keepDown) => (calls.push(`finalize:${[...keepDown].join(',')}`), real.finalize(keepDown)),
        downServers: () => real.downServers(),
        failures: () => real.failures(),
      };
    },
  };
}
