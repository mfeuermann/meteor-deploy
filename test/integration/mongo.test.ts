/**
 * MUP's built-in MongoDB end to end on one fake server (mongo plan Task 8): `setup` runs it like
 * MUP, the app reads and writes through MUP's MONGO_URL, the data survives every app command,
 * the app commands stop early when MongoDB does not run, a patch version change recreates the
 * container and a downgrade is refused before anything changes.
 */
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../../src/core/context.js';
import { mongoShell } from '../../src/mongo/shell.js';
import { createReporter } from '../../src/output/reporter.js';
import type { LocalTerminal } from '../../src/ssh/interactive.js';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, containerId, curlApp, sampleProject, waitFor, writeTestConfig } from './helpers.js';

const MONGO_VERSION = '7.0.14';
const MONGO_PATCH = '7.0.15';

let server: FakeServer;
let p: ReturnType<typeof sampleProject>;

describe('the built-in MongoDB', () => {
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const write = (version: string) => writeTestConfig(p.deployDir, [server], { mongo: { version, servers: { [server.name]: {} } } });
  const read = async () => JSON.parse((await curlApp(server, '/mongo/read')) || 'null') as string[] | null;
  const mongoId = () => containerId(server, 'mongodb');
  const startNew = async () => (await server.exec('cat /opt/mongodb/mongo-start-new.sh')).stdout;

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject({ mongo: true });
    write(MONGO_VERSION);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('setup starts MongoDB with the meteor replica set', async () => {
    const r = await cli(['setup', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect((await server.exec("docker inspect -f '{{.State.Running}}' mongodb")).stdout.trim()).toBe('true');
    expect((await server.exec("docker exec mongodb mongosh --quiet --eval 'rs.status().set'")).stdout.trim()).toBe('meteor');
  });

  it('a second setup keeps the container', async () => {
    const before = await mongoId();
    const r = await cli(['setup', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('MongoDB is up to date (container kept)');
    expect(await mongoId()).toBe(before);
  });

  it('deploy, then the app writes and reads through MONGO_URL', async () => {
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(await curlApp(server, '/mongo/write?v=a')).toBe('ok');
    expect(await read()).toEqual(['a']);
  });

  it('reconfig, restart and rollback keep the data', async () => {
    // A second version, so that rollback has a target.
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    for (const command of ['reconfig', 'restart', 'rollback']) {
      const r = await cli([command, ...config()], p.root);
      expect(r.code, `${command}\n${r.output}`).toBe(0);
      expect(await read(), command).toEqual(['a']);
    }
  });

  it('deploy and restart stop early when MongoDB is stopped', async () => {
    const stop = await cli(['mongo', 'stop', ...config()], p.root);
    expect(stop.code, stop.output).toBe(0);
    const app = await containerId(server, APP_NAME);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).not.toBe(0);
    expect(deploy.output).toContain('is not running. Start it with: comet-deploy mongo start');
    expect(deploy.output).not.toContain('==> Build');
    const restart = await cli(['restart', ...config()], p.root);
    expect(restart.code, restart.output).not.toBe(0);
    expect(restart.output).toContain('is not running');
    expect(await containerId(server, APP_NAME)).toBe(app);
    const start = await cli(['mongo', 'start', ...config()], p.root);
    expect(start.code, start.output).toBe(0);
    expect(start.output).toContain('MongoDB started');
    // The app reconnects by itself once MongoDB is back.
    expect(await waitFor(async () => JSON.stringify(await read()) === '["a"]', 60_000, 1000)).toBe(true);
  });

  it('a patch version change recreates the container and keeps the data', async () => {
    write(MONGO_PATCH);
    const before = await mongoId();
    const r = await cli(['setup', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(`MongoDB recreated: the start script changed (${MONGO_VERSION} → ${MONGO_PATCH})`);
    expect(await mongoId()).not.toBe(before);
    expect(await waitFor(async () => JSON.stringify(await read()) === '["a"]', 60_000, 1000)).toBe(true);
  });

  it('an older series is refused and nothing changes', async () => {
    write('6.0.13');
    const script = await startNew();
    const before = await mongoId();
    for (const args of [['mongo', 'setup'], ['setup']]) {
      const r = await cli([...args, ...config()], p.root);
      expect(r.code, r.output).not.toBe(0);
      expect(r.output).toContain('older release series');
    }
    expect(await startNew()).toBe(script);
    expect(await mongoId()).toBe(before);
    write(MONGO_PATCH);
  });

  it('mongo shell, logs and status', async () => {
    // Our `mongo shell` over SSH, with stdin that is not a terminal (so no pty is asked for).
    // Without a terminal mongosh still prints its prompt, which names the database (dbName).
    expect(await ourShell('db.runCommand({ping: 1}).ok\n')).toMatch(/ sampleapp> 1$/m);
    const logs = await cli(['mongo', 'logs', '--tail', '5', ...config()], p.root);
    expect(logs.code, logs.output).toBe(0);
    expect(logs.output.trim()).not.toBe('');
    const status = await cli(['mongo', 'status', ...config()], p.root);
    expect(status.code, status.output).toBe(0);
    expect(status.output).toContain('running on server');
    expect(status.output).toContain(`Version ${MONGO_PATCH}`);
    // Read from the running MongoDB (the version guard uses the same read).
    expect(status.output).toContain('Feature compatibility: 7.0');
    const all = await cli(['status', ...config()], p.root);
    expect(all.output).toContain('=> MongoDB status');
  });
});

/** Runs `mongo shell` with `input` on stdin; returns what the shell printed. */
async function ourShell(input: string): Promise<string> {
  const ctx = await createContext({ config: join(p.deployDir, 'mup.js') }, { cwd: p.root, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (d) => (out += d));
  try {
    const done = mongoShell(ctx, { stdin, stdout, stderr: stdout } as unknown as LocalTerminal);
    stdin.end(input);
    await done;
  } finally {
    await ctx.ssh.closeAll();
  }
  return out;
}
