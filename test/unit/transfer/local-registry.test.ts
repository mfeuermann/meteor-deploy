import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../../src/local/exec.js';
import { ensureLocalRegistry, stopLocalRegistry, type RegistryEnv } from '../../../src/transfer/local-registry.js';
import { tempDir } from '../../helpers/fs.js';

/** A fake `docker` CLI for the registry container: records calls, answers like Docker. */
function fakeDocker(o: { running?: boolean; runConflict?: boolean } = {}) {
  const calls: string[] = [];
  let state: 'missing' | 'running' | 'stopped' = o.running ? 'running' : 'missing';
  const res = (code: number, stdout = '', stderr = ''): RunResult => ({ code, stdout, stderr });
  const docker = async (args: string[]): Promise<RunResult> => {
    calls.push(args[0]);
    switch (args[0]) {
      case 'inspect':
        return state === 'missing' ? res(1, '', 'Error: No such object') : res(0, state === 'running' ? 'true\n' : 'false\n');
      case 'run':
        if (o.runConflict) {
          // another deploy created the container a moment earlier
          state = 'running';
          return res(125, '', 'docker: Error response from daemon: Conflict. The container name "/comet-deploy-registry" is already in use.');
        }
        state = 'running';
        return res(0, 'abc\n');
      case 'start':
        state = 'running';
        return res(0);
      case 'port':
        return res(0, '127.0.0.1:5555\n');
      case 'stop':
        state = 'stopped';
        return res(0);
      default:
        return res(1, '', `unexpected docker ${args.join(' ')}`);
    }
  };
  return { docker, calls };
}

function env(d: ReturnType<typeof fakeDocker>, leaseDir: string, pid: number, alive: Set<number>): RegistryEnv {
  return { docker: d.docker, ready: async () => {}, leaseDir, pid, isAlive: (p) => alive.has(p) };
}

describe('local registry shared by concurrent deploys (M5)', () => {
  it('stops the registry only when the last running deploy is done', async () => {
    const d = fakeDocker();
    const dir = tempDir();
    const alive = new Set([100, 200]);
    expect(await ensureLocalRegistry(env(d, dir, 100, alive))).toEqual({ port: 5555 });
    expect(await ensureLocalRegistry(env(d, dir, 200, alive))).toEqual({ port: 5555 });

    expect(await stopLocalRegistry(env(d, dir, 100, alive))).toBe(false);
    expect(d.calls).not.toContain('stop');
    expect(await stopLocalRegistry(env(d, dir, 200, alive))).toBe(true);
    expect(d.calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ignores the lease of a deploy that died without cleaning up', async () => {
    const d = fakeDocker();
    const dir = tempDir();
    await ensureLocalRegistry(env(d, dir, 100, new Set([100, 200])));
    await ensureLocalRegistry(env(d, dir, 200, new Set([100, 200])));
    // process 200 was killed
    expect(await stopLocalRegistry(env(d, dir, 100, new Set([100])))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('treats "container name already in use" as started by another deploy', async () => {
    const d = fakeDocker({ runConflict: true });
    expect(await ensureLocalRegistry(env(d, tempDir(), 100, new Set([100])))).toEqual({ port: 5555 });
    expect(d.calls).toEqual(['inspect', 'run', 'inspect', 'port']);
  });

  it('starts a stopped registry container and reuses a running one', async () => {
    const stopped = fakeDocker({ running: true });
    await stopped.docker(['stop']);
    stopped.calls.length = 0;
    await ensureLocalRegistry(env(stopped, tempDir(), 100, new Set([100])));
    expect(stopped.calls).toEqual(['inspect', 'start', 'port']);

    const running = fakeDocker({ running: true });
    await ensureLocalRegistry(env(running, tempDir(), 100, new Set([100])));
    expect(running.calls).toEqual(['inspect', 'port']);
  });
});
