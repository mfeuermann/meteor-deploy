import { CometError } from '../core/errors.js';
import { run } from '../local/exec.js';

const REGISTRY_IMAGE = 'registry:2.8.3';
const CONTAINER = 'comet-deploy-registry';
const VOLUME = 'comet-deploy-registry-data';
const READY_TIMEOUT_MS = 30_000;

async function docker(args: string[], what: string): Promise<string> {
  const r = await run('docker', args);
  if (r.code !== 0) throw new CometError(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

async function registryPort(): Promise<number> {
  const out = await docker(['port', CONTAINER, '5000/tcp'], 'Reading the local registry port');
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

/**
 * Local Docker Distribution registry, published on 127.0.0.1 only, with a
 * persistent volume (unchanged layers are not pushed again).
 */
export async function ensureLocalRegistry(): Promise<{ port: number }> {
  const state = await run('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER]);
  if (state.code !== 0) {
    await docker(
      ['run', '-d', '--name', CONTAINER, '--restart', 'no', '-p', '127.0.0.1::5000', '-v', `${VOLUME}:/var/lib/registry`, REGISTRY_IMAGE],
      'Starting the local registry',
    );
  } else if (state.stdout.trim() !== 'true') {
    await docker(['start', CONTAINER], 'Starting the local registry');
  }
  const port = await registryPort();
  await waitReady(port);
  return { port };
}

/** Pushes a local image to the registry; returns the reference without host. */
export async function pushToLocalRegistry(localTag: string, port: number, onLine?: (l: string) => void): Promise<string> {
  const remote = `127.0.0.1:${port}/${localTag}`;
  await docker(['tag', localTag, remote], `Tagging ${localTag}`);
  try {
    const r = await run('docker', ['push', remote], { onLine });
    if (r.code !== 0) throw new CometError(`Pushing ${localTag} to the local registry failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-20).join('\n')}`);
  } finally {
    await run('docker', ['rmi', remote]);
  }
  return localTag;
}

export async function stopLocalRegistry(): Promise<void> {
  await run('docker', ['stop', CONTAINER]);
}
