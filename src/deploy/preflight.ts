/**
 * Preflight: the checks that run before the build, so a problem that would stop the deploy later
 * (after minutes of building) is reported up front, all problems at once. Collecting the facts
 * (`runPreflight`) is kept apart from judging them (`evaluatePreflight`, a pure function).
 * It also decides which platform each server needs an image for.
 */
import type { CometOptions, Platform } from '../config/types.js';
import type { CommandContext } from '../core/context.js';
import { CometError } from '../core/errors.js';
import { meteorExecutable } from '../build/meteor-build.js';
import { buildxPlatforms, dockerAvailable } from '../local/docker.js';
import { run } from '../local/exec.js';
import { readLock, serverFacts, type LockInfo, type ServerFacts } from '../remote/ops.js';
import { probeForwarding } from '../transfer/tunnel.js';

export type { Platform };

/** The oldest Docker major version accepted on a server, the same minimum as MUP. */
const MIN_DOCKER_MAJOR = 18;
/** Free space for Docker below which a warning (not an error) is printed. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

/** Docker platform for a server's `uname -m`. Throws `CometError` for other architectures. */
export function platformForArch(unameM: string): Platform {
  const a = unameM.trim();
  if (a === 'x86_64' || a === 'amd64') return 'linux/amd64';
  if (a === 'aarch64' || a === 'arm64') return 'linux/arm64';
  throw new CometError(`Unsupported server architecture "${a}" (supported: x86_64, aarch64).`, {
    hint: 'Set cometDeploy.platform to override the detected platform.',
  });
}

/** Everything preflight found out, as plain data. */
export interface PreflightInput {
  /** Local Docker, the platforms the buildx builder can build for, and whether `meteor` runs. */
  local: { docker: { ok: boolean; version?: string; error?: string }; platforms: string[]; meteorOk: boolean; meteorExecutable?: string };
  /**
   * Per server: its facts, or `error` when they could not be read (e.g. no SSH connection);
   * `lock`: the current lock holder (null = free or not checked); `forwardingError`: why the
   * server refuses reverse port forwarding (null/absent = it works or was not checked).
   */
  servers: Record<string, { facts?: ServerFacts; error?: string; lock?: LockInfo | null; forwardingError?: string | null }>;
  /** `cometDeploy.platform`: `auto` (from `uname -m`) or a fixed platform for every server. */
  override: CometOptions['platform'];
  /** Whether this command builds locally; the local checks only matter then. */
  needsBuild: boolean;
  /** Whether a held lock is an error. */
  checkLocks: boolean;
  /**
   * Whether the image goes to the servers (deploy, `meteor push`; not `meteor build`): only then
   * do reverse port forwarding and the app directories from `setup` matter.
   */
  distributes: boolean;
}

export interface PreflightResult {
  /** Problems that stop the command. */
  errors: string[];
  /** Problems worth knowing about that do not stop it. */
  warnings: string[];
  /** The platform each server needs an image for. */
  platformByServer: Record<string, Platform>;
  /** The distinct platforms to build, one image each. */
  platforms: Platform[];
}

function describeLock(l: LockInfo): string {
  return `${l.user}@${l.machine} (pid ${l.pid}, "${l.command}", since ${l.startedAt || 'unknown'})`;
}

/**
 * Judges the collected facts and returns every error and warning at once instead of stopping at
 * the first one. Pure: no I/O, so it is tested with plain data.
 */
export function evaluatePreflight(i: PreflightInput): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const platformByServer: Record<string, Platform> = {};

  if (i.needsBuild) {
    if (!i.local.docker.ok) errors.push(`Local Docker is not available: ${i.local.docker.error ?? 'unknown error'}`);
    if (!i.local.meteorOk) {
      const exe = i.local.meteorExecutable ?? 'meteor';
      errors.push(`The "${exe}" command was not found locally. Install Meteor to build the app${exe === 'meteor' ? '' : ' or fix buildOptions.executable'}.`);
    }
  }

  for (const [name, s] of Object.entries(i.servers)) {
    if (s.error || !s.facts) {
      errors.push(`Server "${name}": ${s.error ?? 'no facts'}`);
      continue;
    }
    const f = s.facts;
    if (!f.hasBash) errors.push(`Server "${name}": bash is required on the server.`);
    if (i.distributes && f.appSetup === false) errors.push(`Server "${name}": the app is not set up on this server yet. Run "comet-deploy setup" first.`);
    if (i.distributes && s.forwardingError) {
      errors.push(
        `Server "${name}": SSH reverse port forwarding does not work (${s.forwardingError}). ` +
          'comet-deploy sends the image through it: set "AllowTcpForwarding yes" in /etc/ssh/sshd_config and reload sshd.',
      );
    }
    // sudo comes first: the Docker facts are read through sudo, so without working sudo Docker
    // would look missing and the error would point at the wrong problem.
    if (f.sudo === 'password') {
      errors.push(
        `Server "${name}": sudo asks for a password. The SSH user needs passwordless sudo, like with MUP ` +
          '(e.g. "deployer ALL=(ALL) NOPASSWD:ALL" in /etc/sudoers.d/deployer), or connect as root.',
      );
    } else if (f.sudo === 'missing') {
      errors.push(`Server "${name}": sudo is not installed. Every remote command runs through sudo (as with MUP); install it, e.g. "apt-get install sudo".`);
    } else if (!f.dockerRunning) {
      errors.push(`Server "${name}": Docker is ${f.dockerVersion ? 'not running' : 'not installed'}. Run "comet-deploy setup".`);
    } else {
      // A version that cannot be parsed is let through rather than blocking the deploy.
      const major = Number(/^(\d+)\./.exec(f.dockerVersion ?? '')?.[1]);
      if (Number.isFinite(major) && major < MIN_DOCKER_MAJOR) {
        errors.push(`Server "${name}": Docker ${f.dockerVersion} is too old (minimum ${MIN_DOCKER_MAJOR}). Run "comet-deploy docker update".`);
      }
      if (f.dockerRootFreeBytes !== null && f.dockerRootFreeBytes < LOW_DISK_BYTES) {
        warnings.push(`Server "${name}": only ${(f.dockerRootFreeBytes / 1024 ** 3).toFixed(1)} GiB free for Docker.`);
      }
    }
    // This only makes a held lock fail before the build instead of after it. The lock itself is
    // taken atomically after the build, and that is what keeps two deploys apart.
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
  // Only when Docker works: otherwise buildx reports no platforms and every platform would
  // repeat the Docker error in a less helpful form.
  if (i.needsBuild && i.local.docker.ok && i.local.platforms.length === 0) {
    // `docker buildx ls` failed or listed nothing: the plugin is missing, not the emulation.
    errors.push('Docker buildx is not available locally ("docker buildx ls" failed). Install the buildx plugin; Docker Desktop and OrbStack include it.');
  } else if (i.needsBuild && i.local.docker.ok) {
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

/**
 * Collects the local and per-server facts in parallel (read-only on the servers), prints the
 * warnings and throws one `CometError` that lists every error. Returns the platform plan.
 */
export async function runPreflight(ctx: CommandContext, servers: string[], o: { needsBuild: boolean; checkLocks: boolean; distributes: boolean }): Promise<PreflightResult> {
  const appName = ctx.config.app.name;
  // Started first and awaited last, so the local checks overlap with the SSH round trips.
  const localP = o.needsBuild
    ? Promise.all([dockerAvailable(), buildxPlatforms(), run(meteorExecutable(ctx.config.app), ['--version']).then((r) => r.code === 0)])
    : Promise.resolve([{ ok: true }, [], true] as const);
  // allSettled: a server that cannot be reached becomes one error in the list instead of
  // hiding the results of the others.
  const serverResults = await Promise.allSettled(
    servers.map(async (name) => {
      const conn = await ctx.ssh.get(name);
      const facts = await serverFacts(conn, o.distributes ? appName : undefined);
      const lock = o.checkLocks ? await readLock(conn, appName) : null;
      // The image reaches the servers through a reverse tunnel; `meteor build` sends nothing.
      const forwardingError = o.distributes ? await probeForwarding(conn) : null;
      return { facts, lock, forwardingError };
    }),
  );
  const [docker, platforms, meteorOk] = await localP;
  const input: PreflightInput = {
    local: { docker, platforms: [...platforms], meteorOk, meteorExecutable: meteorExecutable(ctx.config.app) },
    servers: Object.fromEntries(
      servers.map((name, idx) => {
        const r = serverResults[idx];
        return [name, r.status === 'fulfilled' ? r.value : { error: (r.reason as Error)?.message ?? String(r.reason) }];
      }),
    ),
    override: ctx.config.cometDeploy.platform,
    needsBuild: o.needsBuild,
    checkLocks: o.checkLocks,
    distributes: o.distributes,
  };
  const result = evaluatePreflight(input);
  for (const w of result.warnings) ctx.reporter.warn(w);
  if (result.errors.length > 0) {
    throw new CometError(`Preflight failed:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return result;
}
