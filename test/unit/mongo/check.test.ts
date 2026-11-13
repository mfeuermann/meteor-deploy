import { describe, expect, it } from 'vitest';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { assertPhase1Supported, deployPipeline, reconfigPipeline, restartPipeline, rollbackPipeline, startAll, type PipelineDeps } from '../../../src/deploy/pipeline.js';
import { assertMongoRunning, mongoNotRunningMessage } from '../../../src/mongo/check.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ImageVersions } from '../../../src/remote/ops.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

const MUP = (o: { appServers?: string; mongo?: string; extra?: string } = {}) => `module.exports = {
  servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' }, two: { host: '192.0.2.2', username: 'root', password: 'pw' } },
  app: { name: 'myapp', path: '../app', servers: ${o.appServers ?? '{ one: {} }'}, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
  mongo: ${o.mongo ?? "{ version: '7.0.14', servers: { one: {} } }"},
  ${o.extra ?? ''}
};`;

/** `answers`: what the mongo check prints per server; an Error is a connection that fails. */
async function setup(o: Parameters<typeof MUP>[0] = {}, answers: Record<string, string | Error> = {}) {
  const dir = tempDir({ '.deploy/mup.js': MUP(o), '.deploy/settings.json': '{"public":{}}' });
  const calls: string[] = [];
  const conn = (name: string) =>
    ({
      name,
      host: name,
      exec: async (cmd: string): Promise<ExecResult> => {
        calls.push(`exec:${name}`);
        expect(cmd).toContain('docker inspect');
        return { code: 0, stdout: (answers[name] as string) ?? 'running=true\nset_up=1\n', stderr: '' };
      },
    }) as unknown as SshConnection;
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js' },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: () => {} }),
      sshPoolFactory: () => ({
        get: async (n: string) => {
          const a = answers[n];
          if (a instanceof Error) throw a;
          return conn(n);
        },
        closeAll: async () => {},
      }),
    },
  );
  return { ctx, calls };
}

describe('mongoNotRunningMessage', () => {
  it('says how to start MongoDB when it is set up', () => {
    expect(mongoNotRunningMessage('one', true, null)).toBe('Server "one": MongoDB (container "mongodb") is not running. Start it with: comet-deploy mongo start');
  });

  it('says how to set it up when it is not', () => {
    expect(mongoNotRunningMessage('one', false, null)).toBe('Server "one": MongoDB (container "mongodb") is not running. Set it up with: comet-deploy setup');
  });

  it('gives the reason when the config cannot run the built-in MongoDB', () => {
    expect(mongoNotRunningMessage('one', true, 'Use an external database.')).toBe('Server "one": MongoDB (container "mongodb") is not running. Use an external database.');
  });
});

describe('assertMongoRunning', () => {
  it('lists every server where MongoDB does not run in one error', async () => {
    const s = await setup({ appServers: '{ one: {}, two: {} }' }, { one: 'running=false\nset_up=1\n', two: new Error('connect ETIMEDOUT') });
    const err = await assertMongoRunning(s.ctx, ['one', 'two']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CometError);
    const msg = (err as Error).message;
    expect(msg).toContain('Server "two": connect ETIMEDOUT');
    // two app servers: the built-in MongoDB cannot work, and the error says why
    expect(msg).toMatch(/Server "one": MongoDB \(container "mongodb"\) is not running\. MUP's built-in MongoDB needs exactly one app server/);
  });

  it('passes when MongoDB runs', async () => {
    const s = await setup();
    await assertMongoRunning(s.ctx, ['one']);
    expect(s.calls).toEqual(['exec:one']);
  });

  it('does nothing without a mongo section', async () => {
    const s = await setup({ mongo: 'undefined' });
    await assertMongoRunning(s.ctx, ['one']);
    expect(s.calls).toEqual([]);
  });
});

const three: ImageVersions = { latestId: 'c', previousId: 'b', versions: [{ tag: '20261103-100000', id: 'c' }, { tag: '20261102-100000', id: 'b' }] };

/** Pipeline deps that record every step; `checkMongo` fails like a stopped MongoDB. */
function deps(calls: string[]): Partial<PipelineDeps> {
  return {
    checkMongo: async () => {
      calls.push('check-mongo');
      throw new CometError(mongoNotRunningMessage('one', true, null));
    },
    acquireLock: async (c) => (calls.push(`lock:${c.name}`), { ok: true }),
    releaseLock: async (c) => void calls.push(`release:${c.name}`),
    listVersions: async () => three,
    readHistory: async () => [],
    activateServer: async (d) => (calls.push(`activate:${d.serverName}`), { server: d.serverName, status: 'healthy', durationMs: 1 } as ActivationResult),
    startServer: async (d) => (calls.push(`start:${d.serverName}`), { server: d.serverName, status: 'healthy', durationMs: 1 }),
    appendHistory: async () => {},
  };
}

describe('the app commands with a mongo section', () => {
  const runs: Array<[string, (ctx: CommandContext, d: Partial<PipelineDeps>) => Promise<unknown>]> = [
    ['reconfig', (ctx, d) => reconfigPipeline(ctx, {}, d)],
    ['restart', (ctx, d) => restartPipeline(ctx, {}, d)],
    ['rollback', (ctx, d) => rollbackPipeline(ctx, {}, d)],
  ];
  for (const [name, run] of runs) {
    it(`${name} checks MongoDB before the lock`, async () => {
      const s = await setup();
      const calls: string[] = [];
      await expect(run(s.ctx, deps(calls))).rejects.toThrow(/comet-deploy mongo start/);
      expect(calls).toEqual(['check-mongo']);
    });
  }

  it('start checks MongoDB before starting', async () => {
    const s = await setup();
    const calls: string[] = [];
    await expect(startAll(s.ctx, deps(calls))).rejects.toThrow(/comet-deploy mongo start/);
    expect(calls).toEqual(['check-mongo']);
  });

  it('the check runs on the selected app servers only', async () => {
    const s = await setup();
    let got: string[] = [];
    await startAll(s.ctx, { ...deps([]), checkMongo: async (_ctx, servers) => void (got = servers) });
    expect(got).toEqual(['one']);
  });

  it('deploy with a mongo section is no longer refused', async () => {
    const s = await setup();
    expect(() => assertPhase1Supported(s.ctx)).not.toThrow();
    const calls: string[] = [];
    let preflight: unknown;
    await expect(
      deployPipeline(
        s.ctx,
        { cachedBuild: false, forceBuild: false },
        {
          ...deps(calls),
          readGitInfo: async () => null,
          preflight: async (_c, _s, p) => {
            preflight = p;
            throw new CometError('stop here');
          },
        },
      ),
    ).rejects.toThrow('stop here');
    expect(preflight).toMatchObject({ mongo: true });
  });

  it('transfer stream is accepted, transfer registry is still refused', async () => {
    const stream = (await setup({ extra: "cometDeploy: { transfer: 'stream' }," })).ctx;
    const registry = (await setup({ extra: "cometDeploy: { transfer: 'registry' }," })).ctx;
    expect(() => assertPhase1Supported(stream)).not.toThrow();
    expect(() => assertPhase1Supported(registry)).toThrow(/phase 2/);
  });

  it('privateDockerRegistry is still refused', async () => {
    const s = await setup({ extra: "privateDockerRegistry: { host: 'reg.example.com' }," });
    expect(() => assertPhase1Supported(s.ctx)).toThrow(/phase 2/);
  });
});
