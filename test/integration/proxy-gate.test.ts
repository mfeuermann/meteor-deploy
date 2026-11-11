/**
 * Proxy gate (proxy plan, Task 1; proxy spec §6, main spec §10.2). Everything here sets the
 * proxy up with MUP itself, so it does not depend on comet-deploy's proxy code:
 *
 * (a) MUP's proxy images (zodern/nginx-proxy:v1.1.0, jrcs/letsencrypt-nginx-proxy-companion:v1.13.1)
 *     work on Docker 27.5 and on Docker 29, which only accepts API version 1.44 or newer.
 * (b) A hand-made zero-downtime switch (start `<app>-next` beside the app, health check, wait
 *     until nginx routes to it, stop and remove the old container, rename) drops no request.
 * (c) One regeneration of the nginx config (docker-gen once, inside the proxy container) picks
 *     up a new vhost.d file without restarting the proxy container.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeDockerVersion, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, mup, sampleProject, waitFor, writeTestConfig } from './helpers.js';

const DOMAIN = 'app.test';
const PROXY = 'mup-nginx-proxy';

/** `curl` inside the fake server through the proxy on port 80, with the app's Host header. */
async function viaProxy(server: FakeServer, path: string): Promise<string> {
  return (await server.exec(`curl -s --max-time 15 -H 'Host: ${DOMAIN}' http://localhost${path}`)).stdout.trim();
}

/** The nginx config docker-gen generated inside the proxy container. */
async function nginxConf(server: FakeServer): Promise<string> {
  return (await server.exec(`docker exec ${PROXY} cat /etc/nginx/conf.d/default.conf`)).stdout;
}

/**
 * The container's IP. Docker 29 no longer has the deprecated `.NetworkSettings.IPAddress`, so
 * this reads the networks, like the fallback of MUP's deploy check and of health-check.sh.
 */
async function containerIp(server: FakeServer, name: string): Promise<string> {
  const out = (await server.exec(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${name}`)).stdout;
  return out.trim().split(/\s+/)[0] ?? '';
}

/**
 * Sets up the proxy and deploys the sample app with MUP on a fresh fake server with Docker `v`.
 * Returns the server; the caller stops it.
 */
async function mupBehindProxy(v: FakeDockerVersion): Promise<{ server: FakeServer; project: ReturnType<typeof sampleProject> }> {
  const [server] = await startFakeServers(1, { docker: v });
  const project = sampleProject();
  // useBuildKit: see interop.test.ts (MUP's own deploy of the sample app needs it).
  writeTestConfig(project.deployDir, [server], { docker: { useBuildKit: true }, proxy: { domains: DOMAIN } });
  const config = ['--config', join(project.deployDir, 'mup.js')];
  const setup = await mup(['setup', ...config], project.root);
  expect(setup.code, setup.output).toBe(0);
  const deploy = await mup(['deploy', ...config], project.root);
  expect(deploy.code, deploy.output).toBe(0);
  return { server, project };
}

for (const v of ['27.5', '29'] as const) {
  describe(`(a) MUP proxy on Docker ${v}`, () => {
    let server: FakeServer;

    // The first run also builds the fake server image with this Docker version.
    beforeAll(async () => {
      ({ server } = await mupBehindProxy(v));
    }, 1_500_000);

    afterAll(async () => {
      await server?.stop();
    });

    it('routes to the app, generates its upstream, and the companion talks to Docker', async () => {
      const version = (await server.exec(`docker version --format '{{.Server.Version}}'`)).stdout.trim();
      console.log(`[gate] Docker server version: ${version}`);
      expect(version.startsWith(v === '29' ? '29.' : '27.5')).toBe(true);
      expect(await waitFor(async () => (await viaProxy(server, '/native')) === '60', 60_000, 1000)).toBe(true);
      const ip = await containerIp(server, APP_NAME);
      expect(ip).not.toBe('');
      expect(await nginxConf(server)).toContain(ip);
      const le = await server.exec(`docker logs ${PROXY}-letsencrypt 2>&1`);
      console.log(`[gate] companion log tail:\n${le.stdout.split('\n').slice(-15).join('\n')}`);
      expect(le.stdout).not.toMatch(/client version|too old|minimum supported api version/i);
      const proxyLog = await server.exec(`docker logs ${PROXY} 2>&1`);
      expect(proxyLog.stdout).not.toMatch(/client version|too old|minimum supported api version/i);
    });
  });
}

describe('(b) zero-downtime prototype and (c) regeneration, Docker 27.5', () => {
  let server: FakeServer;

  beforeAll(async () => {
    ({ server } = await mupBehindProxy('27.5'));
    expect(await waitFor(async () => (await viaProxy(server, '/native')) === '60', 60_000, 1000)).toBe(true);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('(b) switches to a new container without a failed request', async () => {
    // A request every 50 ms through the proxy, in the background; each line is one HTTP status
    // (000 = no connection).
    await server.exec(
      `cat > /tmp/loop.sh <<'EOF'
rm -f /tmp/loop.log /tmp/loop.stop
while [ ! -f /tmp/loop.stop ]; do
  curl -s -o /dev/null -w '%{http_code}\\n' --max-time 10 -H 'Host: ${DOMAIN}' http://localhost/native >> /tmp/loop.log
  sleep 0.05
done
EOF
setsid nohup bash /tmp/loop.sh > /dev/null 2>&1 &`,
    );
    await new Promise((r) => setTimeout(r, 3000));

    const t0 = Date.now();
    const sw = await server.exec(
      `set -e
APP=${APP_NAME}
cd /opt/$APP/config
# The next container: start.sh without its "remove the old container" block, under another name.
sed -e '/# Remove previous version of the app, if exists/,/Finished removing docker containers"/d' \\
    -e 's/--name=\\$APPNAME/--name=$APPNAME-next/' \\
    -e 's/\\(docker network connect .*\\) \\$APPNAME$/\\1 $APPNAME-next/' start.sh > /tmp/next.sh
docker rm -f $APP-next > /dev/null 2>&1 || true
bash /tmp/next.sh > /tmp/next.log 2>&1
IP=""
for i in $(seq 1 120); do
  IP=$(docker inspect -f '{{.NetworkSettings.IPAddress}}' $APP-next)
  if [ -n "$IP" ] && curl -sf -o /dev/null --max-time 2 http://$IP:3000/native; then break; fi
  sleep 1
done
echo "next ip=$IP healthy after ~$i s"
for i in $(seq 1 30); do
  if docker exec ${PROXY} cat /etc/nginx/conf.d/default.conf | grep -q "$IP:3000"; then echo "nginx picked it up"; break; fi
  sleep 0.5
done
docker stop -t 10 $APP > /dev/null
docker rm $APP > /dev/null
docker rename $APP-next $APP
echo switched`,
    );
    console.log(`[gate] switch output (${Date.now() - t0} ms):\n${sw.stdout}${sw.stderr}`);
    expect(sw.code, sw.stderr).toBe(0);
    expect(sw.stdout).toContain('nginx picked it up');
    await new Promise((r) => setTimeout(r, 3000));
    await server.exec('touch /tmp/loop.stop; sleep 1');

    const statuses = (await server.exec('cat /tmp/loop.log')).stdout.split('\n').filter(Boolean);
    const failed = statuses.filter((s) => s !== '200');
    console.log(`[gate] requests: ${statuses.length}, failed: ${failed.length} (${[...new Set(failed)].join(',')})`);
    expect(statuses.length).toBeGreaterThan(50);
    expect(failed).toEqual([]);
    expect(await viaProxy(server, '/native')).toBe('60');
    const names = (await server.exec(`docker ps --format '{{.Names}}'`)).stdout;
    expect(names).toContain(`${APP_NAME}\n`);
    expect(names).not.toContain(`${APP_NAME}-next`);
  });

  it('(c) regenerates the nginx config once without restarting the proxy container', async () => {
    const procfile = await server.exec(`docker exec ${PROXY} cat /app/Procfile`);
    console.log(`[gate] /app/Procfile:\n${procfile.stdout}`);
    const env = await server.exec(`docker exec ${PROXY} sh -c 'echo DOCKER_HOST=$DOCKER_HOST; command -v docker-gen'`);
    console.log(`[gate] ${env.stdout}`);
    const startedBefore = (await server.exec(`docker inspect -f '{{.State.StartedAt}}' ${PROXY}`)).stdout.trim();
    expect(await nginxConf(server)).not.toContain(`vhost.d/${DOMAIN}_location`);

    await server.exec(`echo '# gate test' > /opt/${PROXY}/config/vhost.d/${DOMAIN}_location`);
    const regen = await server.exec(`docker exec ${PROXY} docker-gen -notify "nginx -s reload" /app/nginx.tmpl /etc/nginx/conf.d/default.conf`);
    console.log(`[gate] regenerate: code ${regen.code}\n${regen.stdout}${regen.stderr}`);
    expect(regen.code).toBe(0);
    expect(await nginxConf(server)).toContain(`include /etc/nginx/vhost.d/${DOMAIN}_location;`);
    expect((await server.exec(`docker inspect -f '{{.State.StartedAt}}' ${PROXY}`)).stdout.trim()).toBe(startedBefore);
    expect(await viaProxy(server, '/native')).toBe('60');
  });
});
