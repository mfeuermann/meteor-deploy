import type { CometOptions, Platform } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { buildxPlatforms, dockerAvailable } from '../local/docker.js';
import { run } from '../local/exec.js';
import { readLock, serverFacts, type LockInfo, type ServerFacts } from '../remote/ops.js';

export type { Platform };

const MIN_DOCKER_MAJOR = 18;
const LOW_DISK_BYTES = 5 * 1024 ** 3;

export function platformForArch(unameM: string): Platform {
  const a = unameM.trim();
  if (a === 'x86_64' || a === 'amd64') return 'linux/amd64';
  if (a === 'aarch64' || a === 'arm64') return 'linux/arm64';
  throw new CometError(`Unsupported server architecture "${a}" (supported: x86_64, aarch64).`, {
    hint: 'Set cometDeploy.platform to override the detected platform.',
  });
}

export interface PreflightInput {
  local: { docker: { ok: boolean; version?: string; error?: string }; platforms: string[]; meteorOk: boolean };
  servers: Record<string, { facts?: ServerFacts; error?: string; lock?: LockInfo | null }>;
  override: CometOptions['platform'];
  needsBuild: boolean;
  checkLocks: boolean;
}

export interface PreflightResult {
  errors: string[];
  warnings: string[];
  platformByServer: Record<string, Platform>;
  platforms: Platform[];
}

function describeLock(l: LockInfo): string {
  return `${l.user}@${l.machine} (pid ${l.pid}, "${l.command}", since ${l.startedAt || 'unknown'})`;
}

export function evaluatePreflight(i: PreflightInput): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const platformByServer: Record<string, Platform> = {};

  if (i.needsBuild) {
    if (!i.local.docker.ok) errors.push(`Local Docker is not available: ${i.local.docker.error ?? 'unknown error'}`);
    if (!i.local.meteorOk) errors.push('The "meteor" command was not found locally. Install Meteor to build the app.');
  }

  for (const [name, s] of Object.entries(i.servers)) {
    if (s.error || !s.facts) {
      errors.push(`Server "${name}": ${s.error ?? 'no facts'}`);
      continue;
    }
    const f = s.facts;
    if (!f.hasBash) errors.push(`Server "${name}": bash is required on the server.`);
    if (!f.dockerRunning) {
      errors.push(`Server "${name}": Docker is ${f.dockerVersion ? 'not running' : 'not installed'}. Run "comet-deploy setup".`);
    } else {
      const major = Number(/^(\d+)\./.exec(f.dockerVersion ?? '')?.[1]);
      if (Number.isFinite(major) && major < MIN_DOCKER_MAJOR) {
        errors.push(`Server "${name}": Docker ${f.dockerVersion} is too old (minimum ${MIN_DOCKER_MAJOR}). Run "comet-deploy docker update".`);
      }
      if (f.dockerRootFreeBytes !== null && f.dockerRootFreeBytes < LOW_DISK_BYTES) {
        warnings.push(`Server "${name}": only ${(f.dockerRootFreeBytes / 1024 ** 3).toFixed(1)} GiB free for Docker.`);
      }
    }
    if (i.checkLocks && s.lock) {
      errors.push(`Server "${name}": a deploy lock is held by ${describeLock(s.lock)}. If no deploy is running, release it with "comet-deploy unlock".`);
    }
    try {
      platformByServer[name] = i.override === 'auto' ? platformForArch(f.arch) : i.override;
    } catch (err) {
      errors.push(`Server "${name}": ${(err as Error).message}`);
    }
  }

  const platforms = [...new Set(Object.values(platformByServer))];
  if (i.needsBuild && i.local.docker.ok) {
    for (const p of platforms) {
      if (!i.local.platforms.includes(p)) {
        errors.push(
          `The local Docker builder cannot build for ${p}. Enable emulation: Docker Desktop → Settings → General → ` +
            '"Use Rosetta for x86_64/amd64 emulation", or run "docker run --privileged --rm tonistiigi/binfmt --install all".',
        );
      }
    }
  }
  return { errors, warnings, platformByServer, platforms };
}

/** Collects local and per-server facts in parallel and fails with all problems at once. */
export async function runPreflight(ctx: CommandContext, servers: string[], o: { needsBuild: boolean; checkLocks: boolean }): Promise<PreflightResult> {
  const appName = ctx.config.app.name;
  const localP = o.needsBuild
    ? Promise.all([dockerAvailable(), buildxPlatforms(), run('meteor', ['--version']).then((r) => r.code === 0)])
    : Promise.resolve([{ ok: true }, [], true] as const);
  const serverResults = await Promise.allSettled(
    servers.map(async (name) => {
      const conn = await ctx.ssh.get(name);
      const facts = await serverFacts(conn);
      const lock = o.checkLocks ? await readLock(conn, appName) : null;
      return { facts, lock };
    }),
  );
  const [docker, platforms, meteorOk] = await localP;
  const input: PreflightInput = {
    local: { docker, platforms: [...platforms], meteorOk },
    servers: Object.fromEntries(
      servers.map((name, idx) => {
        const r = serverResults[idx];
        return [name, r.status === 'fulfilled' ? r.value : { error: (r.reason as Error)?.message ?? String(r.reason) }];
      }),
    ),
    override: ctx.config.cometDeploy.platform,
    needsBuild: o.needsBuild,
    checkLocks: o.checkLocks,
  };
  const result = evaluatePreflight(input);
  for (const w of result.warnings) ctx.reporter.warn(w);
  if (result.errors.length > 0) {
    throw new CometError(`Preflight failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return result;
}
