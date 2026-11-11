/**
 * Wrappers around the local `docker` CLI used by preflight and the build: daemon availability,
 * the platforms of the buildx builder, image ids, the base image pull and the image build. Every
 * call runs `docker` without a shell.
 */
import { run } from './exec.js';

/**
 * Whether the local Docker daemon answers, not only the CLI: `docker version` prints the server
 * version only when it can reach the daemon. Never throws.
 */
export async function dockerAvailable(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.code === 0 && r.stdout.trim()) return { ok: true, version: r.stdout.trim() };
  if (r.code === 127) return { ok: false, error: 'docker is not installed (command not found)' };
  return { ok: false, error: r.stderr.trim() || `docker version exited with ${r.code}` };
}

/**
 * Platforms from the `Platforms:` lines of `docker buildx inspect` (one line per builder node),
 * without duplicates. buildx marks platforms that were configured explicitly with a trailing `*`,
 * which is dropped.
 */
export function parseBuildxPlatforms(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*Platforms:\s*(.*)$/.exec(line);
    if (!m) continue;
    for (const p of m[1].split(',')) {
      const v = p.trim().replace(/\*$/, '');
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Platforms the current buildx builder can build for (from `docker buildx inspect`); empty when
 * buildx is missing or fails. A foreign platform appears here only when emulation is set up.
 */
export async function buildxPlatforms(): Promise<string[]> {
  const r = await run('docker', ['buildx', 'inspect']);
  return r.code === 0 ? parseBuildxPlatforms(r.stdout) : [];
}

/** Local image id (`sha256:…`) or null when the reference does not exist. */
export async function imageId(ref: string): Promise<string | null> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** `docker pull --platform`; failures are ignored (like MUP), the build reports real problems. */
export async function pullImage(image: string, platform: string, onLine?: (l: string) => void): Promise<boolean> {
  const r = await run('docker', ['pull', '--platform', platform, image], { onLine });
  return r.code === 0;
}

/**
 * `docker buildx build --load` with the Dockerfile on stdin (`-f -`), so no Dockerfile is written
 * into the build context. `--load` puts the result into the local image store, where the
 * registry push takes it from (a buildx builder with a non-default driver would otherwise keep
 * it only in its own cache). `--progress plain` gives line-based output for the verbose log.
 *
 * Returns the image id of the new tag and the full build log.
 *
 * @throws CometError when the build fails (with the last 60 log lines) or the tag is missing
 *   afterwards.
 */
export async function buildImage(o: {
  contextDir: string;
  dockerfile: string;
  platform: string;
  tag: string;
  buildArgs: Record<string, string>;
  labels?: Record<string, string>;
  onLine?: (l: string) => void;
}): Promise<{ imageId: string; log: string }> {
  const { CometError } = await import('../core/errors.js');
  const args = ['buildx', 'build', '--load', '--progress', 'plain', '--platform', o.platform, '-t', o.tag, '-f', '-'];
  for (const [k, v] of Object.entries(o.buildArgs)) args.push('--build-arg', `${k}=${v}`);
  for (const [k, v] of Object.entries(o.labels ?? {})) args.push('--label', `${k}=${v}`);
  args.push(o.contextDir);
  const log: string[] = [];
  const r = await run('docker', args, {
    input: o.dockerfile,
    onLine: (l) => {
      log.push(l);
      o.onLine?.(l);
    },
  });
  if (r.code !== 0) {
    throw new CometError(`docker buildx build failed for ${o.platform} (exit code ${r.code}):\n${log.slice(-60).join('\n')}`);
  }
  const id = await imageId(o.tag);
  if (!id) throw new CometError(`docker buildx build finished but ${o.tag} is not in the local image store.`);
  return { imageId: id, log: log.join('\n') };
}
