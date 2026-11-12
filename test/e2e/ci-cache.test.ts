/**
 * End-to-end: deploying from a build machine without the BuildKit cache of the earlier builds,
 * as a fresh CI runner is. The first deploy exports its build cache (`--cache-to`); the second
 * one runs on a new buildx builder (docker-container driver, not started yet, as after
 * `docker buildx create`) and imports that cache (`--cache-from`). The dependency layer must
 * be a cache hit, and the server must already have it.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, sampleProject, writeTestConfig } from '../integration/helpers.js';

const BUILDER_A = `comet-test-ci-a-${process.pid}`;
const BUILDER_B = `comet-test-ci-b-${process.pid}`;

/** Creates a buildx builder with the docker-container driver, without starting it. */
const createBuilder = (name: string) => execFileSync('docker', ['buildx', 'create', '--name', name, '--driver', 'docker-container'], { stdio: 'ignore' });
/** Removes a builder and its state (its BuildKit cache); a missing one is fine. */
const removeBuilder = (name: string) => {
  try {
    execFileSync('docker', ['buildx', 'rm', name], { stdio: 'ignore' });
  } catch {
    // already gone
  }
};

/** Runs the CLI with `BUILDX_BUILDER` set, which makes docker buildx use that builder. */
async function withBuilder<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.BUILDX_BUILDER;
  process.env.BUILDX_BUILDER = name;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BUILDX_BUILDER;
    else process.env.BUILDX_BUILDER = before;
  }
}

describe('e2e: deploy from a fresh build machine with an exported build cache', () => {
  let servers: FakeServer[] = [];
  let p: ReturnType<typeof sampleProject>;
  const cacheDir = mkdtempSync(join(tmpdir(), 'comet-buildcache-'));
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const deployedVersion = (output: string) => /Deployed (\S+) to/.exec(output)?.[1];
  const layers = async (s: FakeServer, version: string): Promise<string[]> =>
    JSON.parse((await s.exec(`docker image inspect mup-${APP_NAME}:${version} --format '{{json .RootFS.Layers}}'`)).stdout);
  let first = '';

  beforeAll(async () => {
    servers = await startFakeServers(1);
    p = sampleProject();
    writeTestConfig(p.deployDir, servers);
    createBuilder(BUILDER_A);
    createBuilder(BUILDER_B);
  });

  afterAll(async () => {
    removeBuilder(BUILDER_A);
    removeBuilder(BUILDER_B);
    await Promise.all(servers.map((s) => s.stop()));
  });

  it('1. setup, then a deploy that exports its build cache', async () => {
    expect((await cli(['setup', ...config()], p.root)).code).toBe(0);
    const r = await withBuilder(BUILDER_A, () => cli(['deploy', '--cache-to', `type=local,dest=${cacheDir},mode=max`, ...config()], p.root));
    expect(r.code, r.output).toBe(0);
    first = deployedVersion(r.output)!;
    expect(first).toBeTruthy();
  });

  it('2. a code change deployed from a new builder that imports the cache: the dependency layer is a cache hit the server already has', async () => {
    // The first builder's BuildKit cache and the local image go away, as on a new CI runner.
    removeBuilder(BUILDER_A);
    execFileSync('docker', ['rmi', `mup-${APP_NAME}:${first}`], { stdio: 'ignore' });
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// ci change ${Date.now()}\n`);

    const r = await withBuilder(BUILDER_B, () => cli(['deploy', '--verbose', '--cache-from', `type=local,src=${cacheDir}`, ...config()], p.root));
    expect(r.code, r.output).toBe(0);
    const second = deployedVersion(r.output)!;

    // The npm install step is a cache hit. The steps after it are the app's COPY layers.
    const step = /#(\d+) \[\s*(\d+)\/(\d+)\] RUN cd \/built_app\/programs\/server && npm install/.exec(r.output);
    expect(step, 'npm install step not found in the build output').not.toBeNull();
    expect(r.output).toMatch(new RegExp(`#${step![1]} CACHED`));
    const appLayers = Number(step![3]) - Number(step![2]);

    // Every layer up to the dependency layer is the same in both versions on the server...
    const [s] = servers;
    const before = await layers(s, first);
    const after = await layers(s, second);
    expect(after.length).toBe(before.length);
    expect(after.slice(0, -appLayers)).toEqual(before.slice(0, -appLayers));
    // ...and was not pulled again: docker pull reported those layers as already there.
    const existing = new Set([...r.output.matchAll(/\[s1\] (\w+): Already exists/g)].map((m) => m[1]));
    expect(existing.size).toBeGreaterThanOrEqual(after.length - appLayers);
  });
});
