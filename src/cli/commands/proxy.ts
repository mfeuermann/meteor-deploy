/**
 * The `proxy …` commands, in the order of MUP 1.5.11's proxy plugin (`commands.js`). The work
 * is in `src/proxy/setup.ts`; the logs reuse the app's `logs` passthrough.
 */
import type { CommandContext } from '../../core/context.js';
import { CometError } from '../../core/errors.js';
import { PROXY_NAME, proxyServers } from '../../proxy/render.js';
import { proxyNginxConfig, proxyReconfigShared, proxySetup, proxyStart, proxyStop } from '../../proxy/setup.js';
import type { CommandModule } from '../registry.js';
import { logsPassthrough, streamLogs } from './lifecycle.js';
import { showProxyStatus } from './status.js';

/** `docker logs` of a proxy container; options after `proxy <command>` pass through. */
const logs = (name: string, key: string, container: string, servers: (ctx: CommandContext) => string[]) => (ctx: CommandContext, argv: Record<string, unknown>) =>
  ctx.runner.run(key, () => streamLogs(ctx, logsPassthrough(argv, ['proxy', name]), { container, servers: servers(ctx) }));

export const PROXY_COMMANDS: CommandModule[] = [
  { command: 'setup', describe: 'Setup and start proxy', group: 'proxy', run: (ctx) => proxySetup(ctx) },
  { command: 'reconfig-shared', describe: 'Reconfigure shared properties', group: 'proxy', run: (ctx) => proxyReconfigShared(ctx) },
  {
    command: 'logs',
    describe: 'View logs for proxy (docker logs options pass through)',
    group: 'proxy',
    strict: false,
    run: logs('logs', 'proxy.logs', PROXY_NAME, (ctx) => proxyServers(ctx.config, ctx.serverFilter)),
  },
  {
    command: 'logs-le',
    describe: "View logs for Let's Encrypt (docker logs options pass through)",
    group: 'proxy',
    strict: false,
    // MUP reads these on the app servers (`getSessions(['app'])`), not on proxy.servers.
    // MUP's key is the export name `leLogs`, not the CLI name.
    run: logs('logs-le', 'proxy.leLogs', `${PROXY_NAME}-letsencrypt`, (ctx) => ctx.appServers()),
  },
  {
    // Listed in MUP's help, but its handler is missing, so running it fails there too.
    command: 'envconfig',
    describe: 'Configure environment variables for proxy (not implemented in MUP 1.5.11)',
    group: 'proxy',
    needsConfig: false,
    async run() {
      throw new CometError('"proxy envconfig" has no implementation in MUP 1.5.11 either: it is listed in its help, but running it fails.');
    },
  },
  { command: 'start', describe: "Start proxy and let's encrypt containers", group: 'proxy', run: (ctx) => proxyStart(ctx, { force: true }) },
  { command: 'stop', describe: 'Stop proxy', group: 'proxy', run: (ctx) => proxyStop(ctx) },
  { command: 'nginx-config', describe: 'View generated nginx config', group: 'proxy', run: (ctx) => ctx.runner.run('proxy.nginxConfig', () => proxyNginxConfig(ctx)) },
  { command: 'status', describe: "View the proxy's status", group: 'proxy', run: (ctx) => showProxyStatus(ctx) },
];
