import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CometError } from '../core/errors.js';
import { run, type RunResult } from '../local/exec.js';

const REGISTRY_IMAGE = 'registry:2.8.3';
const CONTAINER = 'comet-deploy-registry';
const VOLUME = 'comet-deploy-registry-data';
const READY_TIMEOUT_MS = 30_000;

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
  isAlive?: (pid: number) => boolean;
}

function defaultLeaseDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'comet-deploy', 'registry-leases');
}

/** `kill(pid, 0)` only checks: EPERM means the process exists but belongs to someone else. */
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

async function docker(e: Required<RegistryEnv>, args: string[], what: string): Promise<string> {
  const r = await e.docker(args);
  if (r.code !== 0) throw new CometError(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

async function registryPort(e: Required<RegistryEnv>): Promise<number> {
  const out = await docker(e, ['port', CONTAINER, '5000/tcp'], 'Reading the local registry port');
  const port = Number(out.split('\n')[0].split(':').pop());
  if (!Number.isInteger(port) || port <= 0) throw new CometError(`Unexpected "docker port" output: ${out}`);
  return port;
}

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
 */
export async function ensureLocalRegistry(env: RegistryEnv = {}): Promise<{ port: number }> {
  const e = resolveEnv(env);
  // The lease comes first: a deploy that finishes meanwhile then sees it and leaves the registry running.
  mkdirSync(e.leaseDir, { recursive: true });
  writeFileSync(join(e.leaseDir, String(e.pid)), new Date().toISOString());

  let running = await containerRunning(e);
  if (running === null) {
    const r = await e.docker(['run', '-d', '--name', CONTAINER, '--restart', 'no', '-p', '127.0.0.1::5000', '-v', `${VOLUME}:/var/lib/registry`, REGISTRY_IMAGE]);
    if (r.code !== 0 && !/already in use/i.test(r.stderr)) throw new CometError(`Starting the local registry failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    // On a name conflict another deploy created it a moment ago: use that one.
    running = r.code === 0 ? true : await containerRunning(e);
  }
  if (!running) await docker(e, ['start', CONTAINER], 'Starting the local registry');
  const port = await registryPort(e);
  await e.ready(port);
  return { port };
}

/** Pushes a local image to the registry; returns the reference without host. */
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
 * Returns whether the container was stopped.
 */
export async function stopLocalRegistry(env: RegistryEnv = {}): Promise<boolean> {
  const e = resolveEnv(env);
  rmSync(join(e.leaseDir, String(e.pid)), { force: true });
  let others = 0;
  let leases: string[] = [];
  try {
    leases = readdirSync(e.leaseDir);
  } catch {
    // no lease directory: nobody else holds the registry
  }
  for (const name of leases) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && e.isAlive(pid)) others++;
    else rmSync(join(e.leaseDir, name), { force: true });
  }
  if (others > 0) return false;
  await e.docker(['stop', CONTAINER]);
  return true;
}
