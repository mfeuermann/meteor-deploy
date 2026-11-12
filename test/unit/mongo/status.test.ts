import { describe, expect, it } from 'vitest';
import { MONGO_COMMANDS } from '../../../src/cli/commands/mongo.js';
import { statusCommand } from '../../../src/cli/commands/status.js';
import { main } from '../../../src/cli/main.js';
import { createContext } from '../../../src/core/context.js';
import { cometScript } from '../../../src/remote/ops.js';
import { formatMongoStatus, parseMongoStatus, type MongoStatus } from '../../../src/mongo/status.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { captureIO, tempDir } from '../../helpers/fs.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

/** The fields MUP's `mongo status` reads from `docker inspect` and from serverStatus. */
const INSPECT = { Created: '2026-11-12T10:00:00Z', RestartCount: 0, State: { Status: 'running', Running: true, Restarting: false, FinishedAt: '0001-01-01T00:00:00Z' } };
const SERVER_STATUS = { version: '7.0.14', connections: { current: 5 }, storageEngine: { name: 'wiredTiger' } };
const RUNNING = `inspect=${b64(INSPECT)}\nserver_status=${b64(SERVER_STATUS)}\nfcv=7.0\n`;

describe('parseMongoStatus', () => {
  it('reads a running MongoDB', () => {
    expect(parseMongoStatus('one', '192.0.2.1', RUNNING)).toEqual<MongoStatus>({
      server: 'one',
      host: '192.0.2.1',
      state: 'running',
      restartCount: 0,
      createdAt: '2026-11-12T10:00:00Z',
      version: '7.0.14',
      connections: 5,
      storageEngine: 'wiredTiger',
      fcv: '7.0',
    });
  });

  it('reads a restarting container without serverStatus', () => {
    const inspect = { ...INSPECT, RestartCount: 4, State: { Status: 'restarting', Running: true, Restarting: true } };
    const s = parseMongoStatus('one', 'h', `inspect=${b64(inspect)}\nserver_status=\nfcv=\n`);
    expect(s).toMatchObject({ state: 'restarting', restartCount: 4, version: null, connections: null, fcv: null });
  });

  it('reports a missing container', () => {
    expect(parseMongoStatus('one', 'h', '')).toMatchObject({ state: 'missing', restartCount: null, version: null });
  });
});

describe('formatMongoStatus', () => {
  const running = parseMongoStatus('one', '192.0.2.1', RUNNING);

  it("prints MUP's lines plus the feature compatibility", () => {
    expect(formatMongoStatus(running, false)).toBe(
      [
        '',
        '=> MongoDB status',
        ' - running on server 192.0.2.1',
        ' - Restarted 0 times',
        ' - Running since 2026-11-12T10:00:00Z',
        ' - Version 7.0.14',
        ' - Connections: 5',
        ' - Storage Engine: wiredTiger',
        ' - Feature compatibility: 7.0',
      ].join('\n'),
    );
  });

  it('prints one line for --overview', () => {
    expect(formatMongoStatus(running, true)).toBe('\n=> MongoDB status\n - running on server 192.0.2.1');
  });

  it('prints Stopped like MUP when the container does not run', () => {
    expect(formatMongoStatus(parseMongoStatus('one', 'h', ''), false)).toBe('\n=> MongoDB status\n - Stopped on server h');
  });
});

async function context(extra = "proxy: { domains: 'a.com' },") {
  const dir = tempDir({
    '.deploy/mup.js': `module.exports = {
      servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
      app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
      mongo: { version: '7.0.14', servers: { one: {} } },
      ${extra}
    };`,
    '.deploy/settings.json': '{}',
  });
  const out: string[] = [];
  const commands: string[] = [];
  const conn = {
    name: 'one',
    host: '192.0.2.1',
    runScript: async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' }),
    exec: async (cmd: string, o?: ExecOptions) => {
      commands.push(cmd);
      o?.onStdout?.('a log line\n');
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as SshConnection;
  const ctx = await createContext(
    { config: '.deploy/mup.js' },
    { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }), sshPoolFactory: () => ({ get: async () => conn, closeAll: async () => {} }) },
  );
  return { ctx, commands, out: () => out.join('') };
}

const command = (name: string) => MONGO_COMMANDS.find((c) => c.command === name)!;

describe('status', () => {
  it('status runs mongo.status before proxy.status', async () => {
    const s = await context();
    await statusCommand.run(s.ctx, {});
    expect(s.ctx.runner.history).toEqual(['default.status', 'meteor.status', 'mongo.status', 'proxy.status']);
    expect(s.out()).toContain('=> MongoDB status');
  });

  it('an unreachable mongo server is printed, not thrown', async () => {
    const s = await context('');
    s.ctx.ssh.get = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await command('status').run(s.ctx, { _: ['mongo', 'status'] });
    expect(s.out()).toContain(' - Could not read the status of server 192.0.2.1: connect ECONNREFUSED');
  });
});

describe('mongo logs', () => {
  it('passes docker logs options on to the mongodb container', async () => {
    const s = await context('');
    await command('logs').run(s.ctx, { _: ['mongo', 'logs'], tail: 10, $0: 'comet-deploy' });
    expect(s.commands).toEqual(['sudo docker logs --tail 10 mongodb 2>&1']);
    expect(s.out()).toContain('a log line');
    expect(s.ctx.runner.history).toEqual(['mongo.logs']);
  });
});

describe('the mongo commands', () => {
  it('"mongo --help" lists them in the order of MUP', async () => {
    const io = captureIO();
    expect(await main(['mongo', '--help'], io.io, { cwd: process.cwd() })).toBe(0);
    const at = ['setup', 'logs', 'start', 'stop', 'shell', 'status'].map((n) => io.stdout().search(new RegExp(`comet-deploy mongo ${n}\\b`)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('mongo-status.sh reads serverStatus and the FCV without failing', async () => {
    const script = await cometScript('mongo-status.sh', {});
    expect(script).toContain('serverStatus');
    expect(script).toContain('featureCompatibilityVersion');
    expect(script).not.toMatch(/^set -e/m);
  });
});
