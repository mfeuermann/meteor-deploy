/**
 * The local Docker Distribution registry that feeds the servers. Built images are pushed into it,
 * and servers pull from it through SSH reverse tunnels. Its volume persists between deploys, so a
 * push uploads only layers the registry does not have yet; the container itself runs only while
 * a deploy needs it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CometError } from '../core/errors.js';
import { run, type RunResult } from '../local/exec.js';

/** Pinned, so every machine runs the same registry version. */
const REGISTRY_IMAGE = 'registry:2.8.3';
/** One container and one volume per machine, shared by all apps and deploys. */
const CONTAINER = 'comet-deploy-registry';
const VOLUME = 'comet-deploy-registry-data';
const READY_TIMEOUT_MS = 30_000;
/** How long a deploy waits for another one to finish starting or stopping the registry. */
const LEASE_LOCK_TIMEOUT_MS = 120_000;

/**
 * What the registry functions touch on this machine. Everything has a real
 * default; tests replace the parts they need.
 */
export interface RegistryEnv {
  /** Runs the `docker` CLI. */
  docker?: (args: string[]) => Promise<RunResult>;
  /** Resolves once the registry answers on `port`. */
  ready?: (port: number) => Promise<void>;
  /** Directory with one lease file per deploy that uses the registry. */
  leaseDir?: string;
  /** This process (owner of the lease). */
  pid?: number;
  /** Whether the process that wrote a lease still runs. */
  isAlive?: (pid: number) => boolean;
}

/** `<cache root>/comet-deploy/registry-leases`, next to the build caches. */
function defaultLeaseDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'comet-deploy', 'registry-leases');
}

/**
 * Runs `fn` while holding `<leaseDir>.lock`, a file created exclusively and named by the pid
 * that holds it. It makes "write my lease, start the container" and "no other lease is left,
 * stop the container" atomic towards each other: without it a deploy could write its lease
 * just after another one counted the leases, then lose the registry in the middle of its
 * push. A lock left by a process that no longer runs is taken over.
 */
async function withLeaseLock<T>(e: Required<RegistryEnv>, fn: () => Promise<T>): Promise<T> {
  const lock = `${e.leaseDir}.lock`;
  mkdirSync(e.leaseDir, { recursive: true });
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lock, String(e.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(lock, 'utf8'));
    } catch {
      continue; // released meanwhile
    }
    // An empty file is a lock that is being written right now: wait for it like for a live one.
    if (Number.isInteger(holder) && holder > 0 && !e.isAlive(holder)) {
      removeStaleLock(lock, holder, e.pid);
      continue;
    }
    if (Date.now() > deadline) {
      throw new CometError(`Timed out waiting for ${lock} (held by process ${holder || 'unknown'})`, {
        hint: 'Another comet-deploy is starting or stopping the local registry. If none is running, delete the file.',
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    // Only our own lock: one taken over meanwhile belongs to another process now.
    if (readPid(lock) === e.pid) rmSync(lock, { force: true });
  }
}

/** The pid in a lock file; NaN when the file is missing, empty or unreadable. */
function readPid(file: string): number {
  try {
    return Number(readFileSync(file, 'utf8')) || NaN;
  } catch {
    return NaN;
  }
}

/**
 * Removes the lock of `deadPid` under a second, short-lived lock, after reading the holder again.
 * Two processes that both saw the same dead holder would otherwise each remove "the stale lock",
 * and the second one would remove the lock the first one had just taken. A takeover lock lasts
 * only a moment, so one older than 10 s was left by a crash and is removed.
 */
function removeStaleLock(lock: string, deadPid: number, pid: number): void {
  const takeover = `${lock}.takeover`;
  try {
    writeFileSync(takeover, String(pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(takeover).mtimeMs > 10_000) rmSync(takeover, { force: true });
    } catch {
      // removed meanwhile
    }
    return;
  }
  try {
    if (readPid(lock) === deadPid) rmSync(lock, { force: true });
  } finally {
    rmSync(takeover, { force: true });
  }
}

/**
 * `kill(pid, 0)` only checks: EPERM means the process exists but belongs to someone else. A pid
 * reused by an unrelated process counts as alive; the registry then keeps running, which is
 * harmless.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function resolveEnv(e: RegistryEnv): Required<RegistryEnv> {
  return {
    docker: e.docker ?? ((args) => run('docker', args)),
    ready: e.ready ?? waitReady,
    leaseDir: e.leaseDir ?? defaultLeaseDir(),
    pid: e.pid ?? process.pid,
    isAlive: e.isAlive ?? pidAlive,
  };
}

/** Runs `docker` and returns its trimmed stdout; a failure throws a CometError naming `what`. */
async function docker(e: Required<RegistryEnv>, args: string[], what: string): Promise<string> {
  const r = await e.docker(args);
  if (r.code !== 0) throw new CometError(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/**
 * The host port Docker published the registry on. It is read on every deploy, not stored: Docker
 * picks it (`-p 127.0.0.1::5000`) and may pick a different one each time the container starts.
 * `docker port` prints one `127.0.0.1:<port>` line per binding.
 */
async function registryPort(e: Required<RegistryEnv>): Promise<number> {
  const out = await docker(e, ['port', CONTAINER, '5000/tcp'], 'Reading the local registry port');
  const port = Number(out.split('\n')[0].split(':').pop());
  if (!Number.isInteger(port) || port <= 0) throw new CometError(`Unexpected "docker port" output: ${out}`);
  return port;
}

/**
 * Polls `GET /v2/` (the registry API check, 200 without authentication) until the registry
 * answers: a container that was just started needs a moment before it accepts connections.
 *
 * @throws CometError after `READY_TIMEOUT_MS`, with the last error or HTTP status.
 */
async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v2/`);
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new CometError(`The local registry on 127.0.0.1:${port} did not become ready: ${last}`);
}

/** Whether the registry container is running (null: it does not exist). */
async function containerRunning(e: Required<RegistryEnv>): Promise<boolean | null> {
  const state = await e.docker(['inspect', '--format', '{{.State.Running}}', CONTAINER]);
  return state.code === 0 ? state.stdout.trim() === 'true' : null;
}

/**
 * Starts (or reuses) the local Docker Distribution registry: published on
 * 127.0.0.1 only, with a persistent volume, so layers that did not change are
 * never pushed again.
 *
 * One registry container serves every deploy on this machine. Each deploy
 * holds a lease (a file named by its pid) until `stopLocalRegistry`, so
 * concurrent deploys of different apps do not stop it under each other.
 *
 * Returns the registry's port on 127.0.0.1, once it answers.
 *
 * @throws CometError when the container cannot be created or started, or does not become ready.
 */
export async function ensureLocalRegistry(env: RegistryEnv = {}): Promise<{ port: number }> {
  const e = resolveEnv(env);
  await withLeaseLock(e, async () => {
    // The lease comes first: a deploy that finishes later sees it and leaves the registry running.
    writeFileSync(join(e.leaseDir, String(e.pid)), new Date().toISOString());
    await startContainer(e);
  });
  const port = await registryPort(e);
  await e.ready(port);
  return { port };
}

/** Creates the registry container, or starts it when it exists but is stopped. */
async function startContainer(e: Required<RegistryEnv>): Promise<void> {
  let running = await containerRunning(e);
  if (running === null) {
    // `127.0.0.1::5000`: loopback only, so the registry is never reachable from the network, and
    // a port that Docker picks, so it cannot clash with anything else on this machine.
    // `--restart no`: it is only needed during a deploy and must not come back with the daemon.
    const r = await e.docker(['run', '-d', '--name', CONTAINER, '--restart', 'no', '-p', '127.0.0.1::5000', '-v', `${VOLUME}:/var/lib/registry`, REGISTRY_IMAGE]);
    if (r.code !== 0 && !/already in use/i.test(r.stderr)) throw new CometError(`Starting the local registry failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    // On a name conflict another deploy created it a moment ago: use that one.
    running = r.code === 0 ? true : await containerRunning(e);
  }
  if (!running) await docker(e, ['start', CONTAINER], 'Starting the local registry');
}

/**
 * Pushes a local image to the registry and returns the reference without host, which each
 * server prefixes with its own tunnel port. The image is tagged `127.0.0.1:<port>/<localTag>`
 * for the push (Docker uploads only the layers the registry lacks, over plain HTTP since the
 * registry is on loopback), and that extra tag is removed again afterwards (`docker rmi` of a tag
 * leaves the image itself alone).
 *
 * @throws CometError when tagging or pushing fails.
 */
export async function pushToLocalRegistry(localTag: string, port: number, onLine?: (l: string) => void): Promise<string> {
  const remote = `127.0.0.1:${port}/${localTag}`;
  const tag = await run('docker', ['tag', localTag, remote]);
  if (tag.code !== 0) throw new CometError(`Tagging ${localTag} failed: ${tag.stderr.trim() || `exit ${tag.code}`}`);
  try {
    const r = await run('docker', ['push', remote], { onLine });
    if (r.code !== 0) throw new CometError(`Pushing ${localTag} to the local registry failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-20).join('\n')}`);
  } finally {
    await run('docker', ['rmi', remote]);
  }
  return localTag;
}

/**
 * Releases this deploy's lease and stops the registry when no other running
 * deploy holds one (leases of processes that no longer exist are removed).
 * Returns whether the container was stopped. Stopping keeps the container and
 * its volume, so the next deploy starts it again with all layers in place.
 */
export async function stopLocalRegistry(env: RegistryEnv = {}): Promise<boolean> {
  const e = resolveEnv(env);
  return withLeaseLock(e, async () => {
    rmSync(join(e.leaseDir, String(e.pid)), { force: true });
    let others = 0;
    for (const name of readdirSync(e.leaseDir)) {
      const pid = Number(name);
      if (Number.isInteger(pid) && pid > 0 && e.isAlive(pid)) others++;
      else rmSync(join(e.leaseDir, name), { force: true });
    }
    if (others > 0) return false;
    await e.docker(['stop', CONTAINER]);
    return true;
  });
}
