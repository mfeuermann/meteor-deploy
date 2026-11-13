import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { localImageStore, removeArchive, saveImageArchive, serverHasImage, streamToServer, type StreamArchive } from '../../../src/transfer/stream.js';

interface SaveRun {
  chunks?: string[];
  code?: number;
  stderr?: string;
  /** Keeps writing to stdout until killed, like a big `docker save`. */
  endless?: boolean;
}

/** A fake `spawn` for `docker save`: the n-th call emits `runs[n]` (the last one repeats). */
function fakeSpawn(...runs: SaveRun[]) {
  const calls: { cmd: string; args: string[] }[] = [];
  let kills = 0;
  const spawn = ((cmd: string, args: string[]) => {
    const o = runs[Math.min(calls.length, runs.length - 1)];
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let timer: NodeJS.Timeout | undefined;
    child.kill = () => {
      kills++;
      clearInterval(timer);
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    if (o.endless) {
      timer = setInterval(() => {
        if (!child.stdout.destroyed) child.stdout.write('x'.repeat(1024));
      }, 1);
      return child;
    }
    setImmediate(() => {
      for (const c of o.chunks ?? []) child.stdout.write(c);
      child.stdout.end();
      if (o.stderr) child.stderr.write(o.stderr);
      child.stderr.end();
      setImmediate(() => child.emit('close', o.code ?? 0, null));
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, calls, kills: () => kills };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'comet-stream-test-'));

/** A fake connection: answers each command with `answer(cmd)` and records the bytes sent to stdin. */
function fakeConn(answer: (cmd: string) => Partial<ExecResult>) {
  const commands: string[] = [];
  const stdin: Buffer[] = [];
  const conn = {
    name: 'two',
    host: 'h',
    exec: async (cmd: string, o: ExecOptions = {}): Promise<ExecResult> => {
      commands.push(cmd);
      if (o.stdin && typeof o.stdin !== 'string') {
        for await (const chunk of o.stdin as Readable) stdin.push(Buffer.from(chunk as Buffer));
      }
      const r = { code: 0, stdout: '', stderr: '', ...answer(cmd) };
      if (r.stdout) o.onStdout?.(r.stdout);
      if (r.stderr) o.onStderr?.(r.stderr);
      o.onClose?.();
      return r;
    },
  } as unknown as SshConnection;
  return { conn, commands, sent: () => Buffer.concat(stdin) };
}

describe('saveImageArchive', () => {
  it('writes a gzip of docker save with mode 600 and removes it with removeArchive', async () => {
    const dir = tmp();
    const { spawn, calls } = fakeSpawn({ chunks: ['layer-one|', 'layer-two'] });
    const a = await saveImageArchive({ localTag: 'mup-app:v1', platform: 'linux/amd64', app: 'app', store: 'classic', spawn, dir });
    expect(calls).toEqual([{ cmd: 'docker', args: ['save', 'mup-app:v1'] }]);
    expect(gunzipSync(readFileSync(a.file)).toString()).toBe('layer-one|layer-two');
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    expect(a.bytes).toBe(statSync(a.file).size);
    expect(a.file.startsWith(dir)).toBe(true);
    expect(a.file).toMatch(/comet-deploy-app-v1-amd64-\d+\.tar\.gz$/);
    removeArchive(a);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('passes --platform with the containerd image store', async () => {
    const dir = tmp();
    const { spawn, calls } = fakeSpawn({ chunks: ['x'] });
    const a = await saveImageArchive({ localTag: 'mup-app:v1-arm64', platform: 'linux/arm64', app: 'app', store: 'containerd', spawn, dir });
    expect(calls[0].args).toEqual(['save', '--platform', 'linux/arm64', 'mup-app:v1-arm64']);
    removeArchive(a);
  });

  it('falls back to a plain docker save when the docker CLI has no --platform', async () => {
    const dir = tmp();
    const { spawn, calls } = fakeSpawn({ code: 125, stderr: 'unknown flag: --platform\n' }, { chunks: ['whole'] });
    const a = await saveImageArchive({ localTag: 'mup-app:v1', platform: 'linux/amd64', app: 'app', store: 'containerd', spawn, dir });
    expect(calls.map((c) => c.args)).toEqual([['save', '--platform', 'linux/amd64', 'mup-app:v1'], ['save', 'mup-app:v1']]);
    expect(gunzipSync(readFileSync(a.file)).toString()).toBe('whole');
    removeArchive(a);
  });

  it('a write error on the local disk stops docker save and says why', async () => {
    const { spawn, kills } = fakeSpawn({ endless: true });
    const dir = join(tmp(), 'missing');
    await expect(saveImageArchive({ localTag: 'mup-app:v1', platform: 'linux/amd64', app: 'app', store: 'classic', spawn, dir })).rejects.toThrow(
      /^Saving mup-app:v1 for the transfer over SSH failed: ENOENT/,
    );
    expect(kills()).toBe(1);
  });

  it('removes the archives of comet-deploy processes that no longer run', async () => {
    const dir = tmp();
    const deadPid = spawnSync('true').pid;
    const dead = join(dir, `comet-deploy-other-v0-amd64-${deadPid}.tar.gz`);
    const alive = join(dir, `comet-deploy-other-v0-amd64-${process.ppid}.tar.gz`);
    const unrelated = join(dir, `backup-${deadPid}.tar.gz`);
    for (const f of [dead, alive, unrelated]) writeFileSync(f, 'old');
    const { spawn } = fakeSpawn({ chunks: ['x'] });
    const a = await saveImageArchive({ localTag: 'mup-app:v1', platform: 'linux/amd64', app: 'app', store: 'classic', spawn, dir });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    removeArchive(a);
  });

  it('a failing docker save leaves no file and says why', async () => {
    const dir = tmp();
    const { spawn } = fakeSpawn({ chunks: ['partial'], code: 1, stderr: 'no space left on device\n' });
    await expect(saveImageArchive({ localTag: 'mup-app:v1', platform: 'linux/amd64', app: 'app', store: 'classic', spawn, dir })).rejects.toThrow(
      'Saving mup-app:v1 for the transfer over SSH failed: no space left on device',
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('streamToServer', () => {
  const archive = (localTag: string): StreamArchive => {
    const dir = tmp();
    const file = join(dir, 'a.tar.gz');
    writeFileSync(file, 'ARCHIVE-BYTES');
    return { file, bytes: 13, localTag, platform: 'linux/amd64' };
  };

  it('loads the archive and keeps only the target tag', async () => {
    const a = archive('mup-app:v1-amd64');
    const { conn, commands, sent } = fakeConn((cmd) => (cmd === 'sudo docker load' ? { stdout: 'Loaded image: mup-app:v1-amd64\n' } : {}));
    await streamToServer(conn, { archive: a, targetTag: 'mup-app:v1' });
    expect(commands).toEqual([
      'sudo docker load',
      "sudo docker tag 'mup-app:v1-amd64' 'mup-app:v1' && sudo docker rmi 'mup-app:v1-amd64'",
      "sudo docker image inspect 'mup-app:v1' > /dev/null 2>&1",
    ]);
    expect(sent().toString()).toBe('ARCHIVE-BYTES');
  });

  it('with the same tag only loads and checks', async () => {
    const a = archive('mup-app:v1');
    const { conn, commands } = fakeConn(() => ({ stdout: 'Loaded image: mup-app:v1\n' }));
    await streamToServer(conn, { archive: a, targetTag: 'mup-app:v1' });
    expect(commands).toEqual(['sudo docker load', "sudo docker image inspect 'mup-app:v1' > /dev/null 2>&1"]);
  });

  it('a docker load that loads nothing fails', async () => {
    const a = archive('mup-app:v1');
    const { conn } = fakeConn(() => ({ code: 1, stderr: 'open /var/lib/docker/tmp: no space left on device' }));
    await expect(streamToServer(conn, { archive: a, targetTag: 'mup-app:v1' })).rejects.toThrow(/\[two\] Loading the image failed/);
  });

  it('fails when the target tag is missing after the load', async () => {
    const a = archive('mup-app:v1');
    const { conn } = fakeConn((cmd) => (cmd === 'sudo docker load' ? { stdout: 'Loaded image ID: sha256:abc\n' } : { code: 1 }));
    await expect(streamToServer(conn, { archive: a, targetTag: 'mup-app:v1' })).rejects.toThrow(/mup-app:v1 is missing/);
  });
});

describe('serverHasImage', () => {
  it('is true when inspect succeeds and false when it fails', async () => {
    expect(await serverHasImage(fakeConn(() => ({ code: 0 })).conn, 'mup-app:v1')).toBe(true);
    expect(await serverHasImage(fakeConn(() => ({ code: 1 })).conn, 'mup-app:v1')).toBe(false);
  });
});

describe('localImageStore', () => {
  it('detects the containerd snapshotter', async () => {
    const run = (stdout: string) => (async () => ({ code: 0, stdout, stderr: '' })) as unknown as typeof import('../../../src/local/exec.js').run;
    expect(await localImageStore({ run: run('[["driver-type","io.containerd.snapshotter.v1"]]') })).toBe('containerd');
    expect(await localImageStore({ run: run('[["Backing Filesystem","extfs"]]') })).toBe('classic');
  });
});
