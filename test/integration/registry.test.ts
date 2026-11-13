/**
 * The registry transfer end to end (registry plan Task 7): two fake servers and a test registry
 * with authentication. A server that is not logged in fails the distribution before anything
 * changes; after `docker setup` a deploy reaches both through the registry, the servers keep
 * only `mup-<app>` tags, the registry gets the version and `:latest`, and a rollback works on
 * one server alone. The local docker login goes to a temporary DOCKER_CONFIG.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { forwardRegistry, isolatedDockerConfig, startTestRegistry, type TestRegistry } from '../harness/registry.js';
import { APP_NAME, cli, curlApp, imageId, sampleProject, writeTestConfig } from './helpers.js';

describe('deploy through a private registry', () => {
  let servers: FakeServer[] = [];
  let reg: TestRegistry;
  let dockerConfig: ReturnType<typeof isolatedDockerConfig>;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const repo = `comet/mup-${APP_NAME}`;
  /** The image the app container runs ('' without one). */
  const containerImage = async (s: FakeServer) => (await s.exec(`docker inspect -f '{{.Image}}' ${APP_NAME} 2>/dev/null`)).stdout.trim();

  beforeAll(async () => {
    dockerConfig = isolatedDockerConfig();
    [servers, reg] = await Promise.all([startFakeServers(2), startTestRegistry()]);
    await Promise.all(servers.map((s) => forwardRegistry(s, reg)));
    p = sampleProject();
    writeTestConfig(p.deployDir, servers, {
      privateDockerRegistry: { host: reg.host, imagePrefix: `${reg.host}/comet`, username: reg.username, password: reg.password },
    });
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
  });

  afterAll(async () => {
    await Promise.all([...servers.map((s) => s.stop()), reg?.stop()]);
    dockerConfig?.restore();
  });

  it('a server that is not logged in fails the distribution, and no app container is started', async () => {
    await servers[1].exec(`docker logout ${reg.host}`);
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).not.toBe(0);
    expect(r.output).toContain('Image distribution failed');
    expect(r.output).toContain('The server is not logged in to the registry: run "comet-deploy docker setup"');
    expect(r.output).not.toContain('==> Activate');
    for (const s of servers) expect(await containerImage(s)).toBe('');
  });

  it('after docker setup a deploy reaches both servers through the registry', async () => {
    const ds = await cli(['docker', 'setup', ...config()], p.root);
    expect(ds.code, ds.output).toBe(0);
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(`registry: logged in to ${reg.host}`);
    expect(r.output).toMatch(new RegExp(`\\[s1\\] distribute .*\\(from 127\\.0\\.0\\.1:${reg.port}\\)`));
    for (const s of servers) expect(await curlApp(s, '/native')).toBe('60');
    // The servers keep the image as mup-<app> only; the registry has the version and :latest.
    for (const s of servers) expect((await s.exec(`docker images --format '{{.Repository}}:{{.Tag}}'`)).stdout).not.toContain(reg.host);
    const version = /registry: pushed \S+:(\S+) in /.exec(r.output)?.[1];
    expect(version).toBeTruthy();
    expect(await reg.tags(repo)).toEqual([version!, 'latest'].sort());
    // No local tag outlives the pushes, and the login went to the temporary docker config.
    expect(execFileSync('docker', ['images', '-q', `${reg.host}/comet/mup-${APP_NAME}`], { encoding: 'utf8' }).trim()).toBe('');
    expect(Object.keys(JSON.parse(readFileSync(join(dockerConfig.dir, 'config.json'), 'utf8')).auths ?? {})).toContain(reg.host);
  });

  it('a second deploy, then a rollback of one server only', async () => {
    const first = await Promise.all(servers.map((s) => imageId(s, 'latest')));
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// registry test change ${Date.now()}\n`);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    const second = await Promise.all(servers.map((s) => imageId(s, 'latest')));
    second.forEach((id, i) => expect(id).not.toBe(first[i]));
    const rollback = await cli(['rollback', '--servers', 's1', ...config()], p.root);
    expect(rollback.code, rollback.output).toBe(0);
    expect(await containerImage(servers[0])).toBe(first[0]);
    expect(await containerImage(servers[1])).toBe(second[1]);
    for (const s of servers) expect(await curlApp(s, '/native')).toBe('60');
  });
});
