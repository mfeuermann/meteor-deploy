import { run } from './exec.js';

export async function dockerAvailable(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.code === 0 && r.stdout.trim()) return { ok: true, version: r.stdout.trim() };
  if (r.code === 127) return { ok: false, error: 'docker is not installed (command not found)' };
  return { ok: false, error: r.stderr.trim() || `docker version exited with ${r.code}` };
}

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

/** Platforms the current buildx builder can build for (from `docker buildx inspect`). */
export async function buildxPlatforms(): Promise<string[]> {
  const r = await run('docker', ['buildx', 'inspect']);
  return r.code === 0 ? parseBuildxPlatforms(r.stdout) : [];
}
