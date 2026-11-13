/**
 * The `stream` transfer, for servers whose sshd refuses TCP forwarding: the whole image goes
 * over SSH as a gzip archive (`docker save` → gzip → `sudo docker load`). The archive is made
 * once per platform into a private temp file and loaded on every server that lacks the version.
 * Slower than the tunnel (every layer travels), but it needs nothing on the server beyond SSH
 * and Docker.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream, createWriteStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Platform } from '../config/types.js';
import { CometError } from '../core/errors.js';
import { run as runLocal } from '../local/exec.js';
import { shq } from '../remote/ops.js';
import { formatFailureOutput, type SshConnection } from '../ssh/connection.js';

/** A saved, compressed image on the local disk, ready to load on servers of its platform. */
export interface StreamArchive {
  file: string;
  /** Size of the compressed file. */
  bytes: number;
  /** The local tag inside the archive; `docker load` recreates it on the server. */
  localTag: string;
  platform: Platform;
}

/** The local Docker's image store: containerd (Docker Desktop 4.34+, new Engine 29 installs) or the classic one. */
export type ImageStore = 'containerd' | 'classic';

/** `312 MB`; one decimal below 10 MB. Decimal megabytes, as Docker prints them. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1e6;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** Archives not removed yet; the exit handler removes them when the process ends early (second Ctrl+C). */
const pending = new Set<string>();
let exitHandler = false;

function track(file: string): void {
  pending.add(file);
  if (exitHandler) return;
  exitHandler = true;
  process.on('exit', () => {
    for (const f of pending) {
      try {
        unlinkSync(f);
      } catch {
        // gone already
      }
    }
  });
}

/**
 * Which image store the local Docker uses: `docker info` lists the containerd snapshotter in
 * its driver status. Anything else, including a failing `docker info`, counts as classic.
 */
export async function localImageStore(o: { run?: typeof runLocal } = {}): Promise<ImageStore> {
  const r = await (o.run ?? runLocal)('docker', ['info', '--format', '{{json .DriverStatus}}']);
  return r.code === 0 && r.stdout.includes('io.containerd.snapshotter') ? 'containerd' : 'classic';
}

/** Runs one `docker save` into `file` through gzip; resolves with the exit code and stderr. */
async function saveOnce(spawn: typeof nodeSpawn, args: string[], file: string): Promise<{ code: number; stderr: string; writeError?: Error }> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<number>((resolve) => {
    child.on('error', (e: Error) => {
      stderr += e.message;
      resolve(127);
    });
    child.on('close', (code: number | null, signal: string | null) => resolve(code ?? (signal ? 128 : 1)));
  });
  // `wx`: a new file only, never through an existing file or symlink; 600 keeps the image private.
  const written = pipeline(child.stdout!, createGzip({ level: 6 }), createWriteStream(file, { flags: 'wx', mode: 0o600 })).then(
    () => undefined,
    (e: Error) => {
      // The disk is full or the file cannot be written: docker save would block on the pipe.
      child.kill();
      return e;
    },
  );
  const [writeError, code] = await Promise.all([written, exited]);
  return { code, stderr, writeError };
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // missing already, or not created
  }
}

/** Whether a process with this pid runs (EPERM: it runs, as another user). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes the archives in `dir` whose comet-deploy process no longer runs: the exit handler
 * cannot run when the process is killed or its terminal is closed (SIGHUP), and the pid in the
 * name means no later run would ever reuse the file. A pid that runs again keeps its file.
 */
function removeStaleArchives(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^comet-deploy-.+-(\d+)\.tar\.gz$/.exec(name)?.[1]);
    if (pid && pid !== process.pid && !pidAlive(pid)) unlinkQuietly(join(dir, name));
  }
}

/**
 * Saves `localTag` with `docker save` and gzips it into a new file in `dir` (default
 * `os.tmpdir()`), mode 600, named `comet-deploy-<app>-<version>-<arch>-<pid>.tar.gz`. With the
 * containerd image store `--platform` limits the archive to this platform (otherwise it holds
 * the whole index with its attestation manifests); a docker CLI without that flag gets a plain
 * `docker save`. The file is removed when the process exits, unless `removeArchive` did first;
 * archives that killed comet-deploy processes left in `dir` are removed before the save.
 *
 * @throws CometError `Saving <localTag> for the transfer over SSH failed: <stderr>`; the partial
 *   file is removed.
 */
export async function saveImageArchive(o: {
  localTag: string;
  platform: Platform;
  app: string;
  store: ImageStore;
  spawn?: typeof nodeSpawn;
  dir?: string;
}): Promise<StreamArchive> {
  const spawn = o.spawn ?? nodeSpawn;
  const dir = o.dir ?? tmpdir();
  const arch = o.platform.split('/')[1] ?? o.platform;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  // The multi-platform local tag ends in `-<arch>` already.
  const version = o.localTag.slice(o.localTag.lastIndexOf(':') + 1).replace(new RegExp(`-${arch}$`), '');
  const file = join(dir, `comet-deploy-${safe(o.app)}-${safe(version)}-${safe(arch)}-${process.pid}.tar.gz`);
  const attempts = o.store === 'containerd' ? [['save', '--platform', o.platform, o.localTag], ['save', o.localTag]] : [['save', o.localTag]];
  removeStaleArchives(dir);
  track(file);
  let r: Awaited<ReturnType<typeof saveOnce>> = { code: 1, stderr: '' };
  for (const args of attempts) {
    unlinkQuietly(file);
    r = await saveOnce(spawn, args, file);
    if (r.code === 0 && !r.writeError) {
      return { file, bytes: statSync(file).size, localTag: o.localTag, platform: o.platform };
    }
    // Only a docker CLI that does not know --platform (before 28) gets the second attempt.
    if (!/unknown flag: --platform/.test(r.stderr)) break;
  }
  unlinkQuietly(file);
  pending.delete(file);
  const why = r.writeError?.message ?? (r.stderr.trim() || `docker save exited with code ${r.code}`);
  throw new CometError(`Saving ${o.localTag} for the transfer over SSH failed: ${why}`, {
    hint: `The archive is written to ${dir}: check the free disk space there and that the local Docker runs.`,
  });
}

/** Removes the archive file; a missing file is fine. Never throws. */
export function removeArchive(a: StreamArchive): void {
  unlinkQuietly(a.file);
  pending.delete(a.file);
}

/** Whether the server's Docker has `tag` (`sudo docker image inspect`). */
export async function serverHasImage(conn: SshConnection, tag: string): Promise<boolean> {
  return (await conn.exec(`sudo docker image inspect ${shq(tag)} > /dev/null 2>&1`)).code === 0;
}

/**
 * Loads the archive on the server: the file goes to `sudo docker load` as stdin (nothing is
 * written to a temp file on the server). When the archive's tag is not `targetTag` (the
 * `-<arch>` tag of a multi-platform build), the image is tagged `targetTag` and the helper tag
 * removed, so the server ends with the same tag the tunnel creates. `onStatus` gets
 * `sent 96 MB of 312 MB` about every 10 %.
 *
 * @throws CometError `[<server>] Loading the image failed …` when `docker load` fails or loads
 *   nothing, the tagging fails, or `targetTag` is missing afterwards.
 */
export async function streamToServer(
  conn: SshConnection,
  o: { archive: StreamArchive; targetTag: string; onStatus?: (line: string) => void },
): Promise<{ durationMs: number }> {
  const start = Date.now();
  const { archive, targetTag, onStatus } = o;
  const failed = (why: string) => new CometError(`[${conn.name}] Loading the image failed${why}`);
  const step = Math.max(1, Math.ceil(archive.bytes / 10));
  let sent = 0;
  let next = step;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      if (onStatus && sent >= next && sent < archive.bytes) {
        onStatus(`sent ${formatBytes(sent)} of ${formatBytes(archive.bytes)}`);
        while (next <= sent) next += step;
      }
      cb(null, chunk);
    },
  });
  const input = createReadStream(archive.file);
  let readError: Error | undefined;
  // A read error ends the input early: docker load then fails on the cut archive instead of
  // waiting for more data.
  input.on('error', (e) => {
    readError = e;
    counter.end();
  });
  input.pipe(counter);
  const load = await conn.exec('sudo docker load', { stdin: counter });
  if (readError) throw failed(`: reading ${archive.file} failed: ${readError.message}`);
  if (load.code !== 0 || !/Loaded image( ID)?: /.test(load.stdout + load.stderr)) {
    throw failed(` (exit code ${load.code}):\n${formatFailureOutput(load)}`);
  }
  if (archive.localTag !== targetTag) {
    const tag = await conn.exec(`sudo docker tag ${shq(archive.localTag)} ${shq(targetTag)} && sudo docker rmi ${shq(archive.localTag)}`);
    if (tag.code !== 0) throw failed(`: tagging ${targetTag} failed (exit code ${tag.code}):\n${formatFailureOutput(tag)}`);
  }
  if (!(await serverHasImage(conn, targetTag))) throw failed(`: ${targetTag} is missing on the server after docker load.`);
  return { durationMs: Date.now() - start };
}
