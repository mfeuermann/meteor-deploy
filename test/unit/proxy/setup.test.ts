import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';
import { formatProxyStatus, proxySetup, proxyStart } from '../../../src/proxy/setup.js';
import { readNginxTmpl, renderNginxConfigSh, renderProxyStartSh, renderServiceConfigureSh } from '../../../src/proxy/render.js';
import { desiredEntries, formatUpstream, parseUpstream } from '../../../src/proxy/upstream.js';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');

/** A name for each script or file the proxy commands send, by a marker in its text. */
function label(s: string): string {
  if (s.includes('sudo mkdir -p /opt/mup-nginx-proxy/certs')) return 'proxy-setup.sh';
  if (s.includes('# proxy-inputs.sh')) return 'digest';
  if (s.includes('CONFIG_EOT') && s.includes('cd /opt/mup-nginx-proxy/config/vhost.d')) return 'nginx-config.sh';
  if (s.includes('Remove broken cert symlinks')) return 'ssl-cleanup.sh';
  if (s.includes('ln -s $APP_CERTS/bundle.crt')) return 'ssl-setup.sh';
  if (s.includes('UPSTREAM=/opt/$PROXYNAME/upstream/$APPNAME')) return 'upstream';
  if (s.includes('sudo bash config/start.sh')) return 'proxy-start.sh';
  if (s.includes('mup-proxy-configure-') && s.includes('NEW_CONTENT')) return 'service-configure.sh';
  if (s.includes('docker rm -f mup-proxy-configure-')) return 'remove-config-container';
  if (s.includes('docker-gen')) return 'regenerate';
  if (s.includes('base64 -w0') && s.includes('/opt/mup-nginx-proxy/upstream/')) return 'read-upstream';
  if (s.includes('echo "acquired"')) return 'lock';
  if (s.includes('LOCK_DIR') || s.includes('deploy.lock')) return 'unlock';
  return s.trim().split('\n')[0].slice(0, 40);
}

interface World {
  /** Digest output per server, per call (the last one repeats). */
  digests?: Record<string, string[]>;
  upstream?: string;
}

async function setup(fixture: string, world: World = {}) {
  const dir = join(fixtures, fixture);
  const out: string[] = [];
  const log: string[] = [];
  const scripts: Record<string, string> = {};
  const writes: Record<string, { content: string; mode?: number }> = {};
  const digestCalls: Record<string, number> = {};
  const conn = (name: string) => {
    const run = async (s: string, o: ExecOptions = {}): Promise<ExecResult> => {
      const text = s === 'bash -s' && typeof o.stdin === 'string' ? o.stdin : s;
      const l = label(text);
      log.push(`${name}:${l}`);
      scripts[l] = text;
      let stdout = '';
      if (l === 'digest') {
        const list = world.digests?.[name] ?? ['digest=a\nrunning=1'];
        const i = (digestCalls[name] = (digestCalls[name] ?? -1) + 1);
        stdout = list[Math.min(i, list.length - 1)];
      } else if (l === 'lock') stdout = 'acquired\n';
      else if (l === 'read-upstream') stdout = world.upstream === undefined ? '-' : Buffer.from(world.upstream).toString('base64');
      return { code: 0, stdout, stderr: '' };
    };
    return {
      name,
      host: name,
      runScript: run,
      runScriptOrThrow: (s: string) => run(s),
      exec: run,
      writeFile: async (path: string, content: string, mode?: number) => {
        log.push(`${name}:write ${path}`);
        writes[path] = { content, mode };
      },
    } as unknown as SshConnection;
  };
  const ctx: CommandContext = await createContext(
    { config: join(dir, 'mup.js') },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    },
  );
  const steps = (server: string) => log.filter((l) => l.startsWith(`${server}:`)).map((l) => l.slice(server.length + 1));
  return { ctx, dir, log, steps, scripts, writes, out: () => out.join('') };
}

describe('proxySetup', () => {
  it('runs MUP proxy setup steps in order with MUP content, then starts the proxy', async () => {
    const s = await setup('proxy-certs', { digests: { one: ['digest=-\nrunning=0'] } });
    await proxySetup(s.ctx);
    const steps = s.steps('one').filter((x) => !['lock', 'unlock', 'digest'].includes(x) && !x.includes('.deploy.lock'));
    expect(steps).toEqual([
      'proxy-setup.sh',
      'write /opt/mup-nginx-proxy/config/start.sh',
      'write /opt/mup-nginx-proxy/config/nginx.tmpl',
      'nginx-config.sh',
      'ssl-cleanup.sh',
      'write /opt/certs-app/config/bundle.crt',
      'write /opt/certs-app/config/private.key',
      'ssl-setup.sh',
      'upstream',
      'remove-config-container',
      'proxy-start.sh',
    ]);
    const all = s.steps('one');
    expect(all.lastIndexOf('digest')).toBeLessThan(all.indexOf('proxy-start.sh'));
    expect(all.indexOf('digest')).toBeLessThan(all.indexOf('write /opt/mup-nginx-proxy/config/start.sh'));
    expect(s.writes['/opt/mup-nginx-proxy/config/start.sh'].content).toBe(await renderProxyStartSh(s.ctx.config));
    expect(s.writes['/opt/mup-nginx-proxy/config/nginx.tmpl'].content).toBe(await readNginxTmpl());
    expect(s.scripts['nginx-config.sh']).toBe(await renderNginxConfigSh(s.ctx.config, s.dir));
    expect(s.writes['/opt/certs-app/config/private.key']).toEqual({ content: readFileSync(join(s.dir, 'cert.key'), 'utf8'), mode: 0o600 });
    // Without load balancing the app's upstream is removed, as upstream.sh does.
    expect(s.scripts.upstream).toContain('sudo rm -f $UPSTREAM');
    expect(s.ctx.runner.history).toEqual(['proxy.setup', 'proxy.start']);
  });

  it('configures the load balancing container after the start (MUP post.proxy.setup)', async () => {
    const world: World = { digests: { one: ['digest=-\nrunning=0'], two: ['digest=-\nrunning=0'] } };
    const s = await setup('proxy-lb', world);
    world.upstream = formatUpstream(s.ctx.config, desiredEntries(s.ctx.config));
    await proxySetup(s.ctx);
    const steps = s.steps('two');
    expect(steps.at(-2)).toBe('service-configure.sh');
    expect(steps.indexOf('proxy-start.sh')).toBeLessThan(steps.indexOf('service-configure.sh'));
    expect(s.scripts['service-configure.sh']).toBe(await renderServiceConfigureSh(s.ctx.config));
  });

  it('does not restart an up-to-date proxy, but regenerates the nginx config', async () => {
    const s = await setup('proxy-certs', { digests: { one: ['digest=same\nrunning=1'] } });
    await proxySetup(s.ctx);
    expect(s.steps('one')).not.toContain('proxy-start.sh');
    expect(s.steps('one')).toContain('regenerate');
    expect(s.out()).toContain('[one] proxy up to date');
  });

  it('restarts the proxy when an input changed or a container is not running', async () => {
    const changed = await setup('proxy-certs', { digests: { one: ['digest=old\nrunning=1', 'digest=new\nrunning=1'] } });
    await proxySetup(changed.ctx);
    expect(changed.steps('one')).toContain('proxy-start.sh');
    const stopped = await setup('proxy-certs', { digests: { one: ['digest=same\nrunning=0'] } });
    await proxySetup(stopped.ctx);
    expect(stopped.steps('one')).toContain('proxy-start.sh');
  });

  it('keeps the down marks of the upstream file', async () => {
    const world: World = {};
    const s = await setup('proxy-lb', world);
    const [one, two] = desiredEntries(s.ctx.config);
    world.upstream = formatUpstream(s.ctx.config, [one, { ...two, down: true }]);
    await proxySetup(s.ctx);
    const content = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(s.scripts.upstream)![1], 'base64').toString('utf8');
    expect(parseUpstream(content).map((e) => `${e.host}${e.down ? ' down' : ''}`)).toEqual(['10.0.0.1', '10.0.0.2 down']);
  });

  it('leaves turning on load balancing to the next deploy: no upstream, no links, no config container', async () => {
    const s = await setup('proxy-lb');
    await proxySetup(s.ctx);
    for (const server of ['one', 'two']) {
      expect(s.steps(server)).not.toContain('upstream');
      expect(s.steps(server)).not.toContain('service-configure.sh');
    }
    expect(s.out()).toContain('[one] load balancing is turned on by the next "comet-deploy deploy", once every server runs with it');
  });

  it('leaves an upstream whose ports or addresses differ from the config to the next deploy', async () => {
    // The servers still listen on 4000; the config has another PORT.
    const s = await setup('proxy-lb', { upstream: '\nserver 10.0.0.1:4000;\n\nserver 10.0.0.2:4000;\n\n' });
    await proxySetup(s.ctx);
    expect(s.steps('one')).not.toContain('upstream');
    expect(s.steps('one')).toContain('service-configure.sh');
    expect(s.out()).toContain('[one] the upstream keeps its servers and ports: the next "comet-deploy deploy" moves each server once it runs the config');
  });

  it('refuses to turn off load balancing while the proxy runs on servers without the app, before any change', async () => {
    const s = await setup('proxy-off-extra', { upstream: '\nserver 10.0.0.1:4000;\n\n' });
    await expect(proxySetup(s.ctx)).rejects.toThrow(
      'Turning off loadBalancing while the proxy runs on servers without the app would leave those proxies without a backend. Remove proxy.servers first or keep loadBalancing.',
    );
    expect(s.log.filter((l) => !/:(lock|unlock|read-upstream)$/.test(l) && !l.includes('.deploy.lock'))).toEqual([]);
  });

  it('stops before it changes anything when a proxy.shared file is missing', async () => {
    const s = await setup('proxy-shared-missing');
    await expect(proxySetup(s.ctx)).rejects.toThrow(/Cannot read proxy\.shared\.nginxConfig \(.*missing-nginx\.conf\)/);
    expect(s.log).toEqual([]);
  });

  it('locks every app server, also outside --servers, and releases the locks', async () => {
    const s = await setup('proxy-lb');
    s.ctx.serverFilter = ['one'];
    await proxySetup(s.ctx);
    expect(s.steps('two')).toContain('lock');
    expect(s.steps('two')).not.toContain('proxy-setup.sh');
    expect(s.steps('two').at(-1)).toBe('unlock');
  });
});

describe('proxyStart', () => {
  it('with force always recreates the proxy containers', async () => {
    const s = await setup('proxy-certs', { digests: { one: ['digest=same\nrunning=1'] } });
    await proxyStart(s.ctx, { force: true });
    expect(s.steps('one')).toContain('proxy-start.sh');
    expect(s.ctx.runner.history).toEqual(['proxy.start']);
  });
});

describe('formatProxyStatus', () => {
  it('uses the MUP layout and adds drained servers and files out of sync', () => {
    const text = formatProxyStatus([
      {
        server: 'one',
        nginx: 'running',
        letsEncrypt: 'running',
        httpPort: '80',
        httpsPort: '443',
        certificates: { 'a.com.chain.pem': 'Feb  1 12:00:00 2027 GMT' },
        downServers: ['two'],
        outOfSync: ['vhost.d/a.com updated'],
      },
    ]);
    const lines = text.split('\n');
    expect(text).toContain('=> Reverse Proxy Status');
    expect(lines).toContain(' - one:');
    expect(lines).toContain('     - Status: running');
    expect(lines).toContain('       - HTTP: 80');
    expect(lines).toContain('       - HTTPS: 443');
    expect(lines).toContain('       - a.com.chain.pem: Feb  1 12:00:00 2027 GMT');
    expect(text).toContain('Drained: two (run "comet-deploy restart --servers two" once it is healthy)');
    expect(text).toContain('Out of sync: vhost.d/a.com updated (run "comet-deploy proxy setup" to sync)');
  });

  it('points at deploy when load balancing still has to be turned on', () => {
    const row = { server: 'one', nginx: 'running', letsEncrypt: 'running', certificates: {}, downServers: [], outOfSync: ['load balancing enabled'] };
    expect(formatProxyStatus([row])).toContain('Out of sync: load balancing enabled (run "comet-deploy deploy" to sync)');
  });
});
