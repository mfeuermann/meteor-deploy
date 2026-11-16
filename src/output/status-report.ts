/**
 * The full `status` report (commands design §4.4): one section per app server under the
 * overview table, and the warnings that go with it. Pure formatting; the data comes from
 * templates/comet/status.sh (parseStatus, parseStatusDetails) and the checks from this
 * computer (src/remote/http-check.ts).
 */
import type { ServerDetails, StatusRow } from '../cli/commands/status.js';

export interface ReportOptions {
  /** The host of a server from the config, for the section header. */
  hostOf: (server: string) => string;
  /** The URL checked from this computer for a server; null when it has no ROOT_URL. */
  localUrlOf: (server: string) => string | null;
  /** Results of the checks from this computer, by URL. */
  fromHere: Map<string, string>;
  /** The app sits behind the shared proxy, so it publishes no port on purpose. */
  behindProxy: boolean;
  now: Date;
}

/** Labels padded to one width, so the values line up. */
const label = (name: string) => `${name}:`.padEnd(12);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `2026-11-16 08:12` in local time. */
function localTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `less than a minute`, `17 min`, `3 h 4 min`, `3 d 2 h`. */
function uptime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Free space in decimal gigabytes, as Docker prints sizes: `18.2 GB`. */
const gigabytes = (kib: number) => `${((kib * 1024) / 1e9).toFixed(1)} GB`;

function serverLine(r: StatusRow, d: ServerDetails): string {
  const parts = [d.os, d.arch, `Docker ${r.docker}`].filter((x): x is string => !!x);
  if (d.dockerFreeKb !== null && d.dockerRoot) parts.push(`${gigabytes(d.dockerFreeKb)} free in ${d.dockerRoot}`);
  return parts.join(', ');
}

function containerLine(r: StatusRow, d: ServerDetails, now: Date): string {
  if (r.container === 'missing') return 'missing';
  let text: string = r.container;
  // A container that never started has StartedAt 0001-01-01T00:00:00Z.
  const started = d.startedAt ? new Date(d.startedAt) : null;
  if (r.container === 'running' && started && started.getFullYear() > 1) text += ` since ${localTime(started)} (${uptime(now.getTime() - started.getTime())})`;
  if (d.restarts !== null) text += `, restarted ${plural(d.restarts, 'time', 'times')}`;
  return text;
}

function versionLine(r: StatusRow, d: ServerDetails): string {
  if (r.version) return d.previousVersion ? `${r.version} (:previous ${d.previousVersion})` : r.version;
  return d.foreignVersion ? 'not a comet-deploy version (MUP deployed it)' : '-';
}

function portsLine(r: StatusRow, d: ServerDetails, behindProxy: boolean): string {
  if (r.container === 'missing') return '-';
  if (d.ports.length) return d.ports.join(', ');
  return behindProxy ? 'none published (behind the proxy)' : 'none published';
}

function envLine(r: StatusRow, d: ServerDetails): string {
  if (r.container === 'missing') return '-';
  if (!d.envNames.length) return 'none';
  return `${plural(d.envNames.length, 'variable', 'variables')}: ${d.envNames.join(', ')}`;
}

function httpLine(r: StatusRow, d: ServerDetails, o: ReportOptions): string {
  const parts = [d.httpUrl ? `${r.http ?? 'no answer'} on the server (${d.httpUrl})` : 'not checked on the server (the app does not run)'];
  const url = o.localUrlOf(r.server);
  if (url) parts.push(`${o.fromHere.get(url) ?? 'not checked'} from this computer (${url})`);
  return parts.join(', ');
}

/**
 * One section per row, separated by a blank line: `== <server> (<host>)` and the lines
 * Server, Container, Version, Ports, Env and HTTP; for a server that could not be reached the
 * single line `unreachable: <reason>`. Env shows names only; values are never part of a row.
 */
export function formatStatusReport(rows: StatusRow[], o: ReportOptions): string {
  return rows
    .map((r) => {
      const head = `== ${r.server} (${o.hostOf(r.server)})`;
      if (r.docker === 'unreachable' || !r.details) return `${head}\nunreachable: ${r.error ?? 'no answer'}`;
      const d = r.details;
      return [
        head,
        label('Server') + serverLine(r, d),
        label('Container') + containerLine(r, d, o.now),
        label('Version') + versionLine(r, d),
        label('Ports') + portsLine(r, d, o.behindProxy),
        label('Env') + envLine(r, d),
        label('HTTP') + httpLine(r, d, o),
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * `The servers run different Docker versions: 27.5.1 (one, three), 26.1.4 (two).` when the
 * reachable servers with Docker running report more than one version; null otherwise.
 */
export function dockerVersionWarning(rows: StatusRow[]): string | null {
  const byVersion = new Map<string, string[]>();
  for (const r of rows) {
    if (!/^\d/.test(r.docker)) continue;
    byVersion.set(r.docker, [...(byVersion.get(r.docker) ?? []), r.server]);
  }
  if (byVersion.size < 2) return null;
  return `The servers run different Docker versions: ${[...byVersion].map(([v, s]) => `${v} (${s.join(', ')})`).join(', ')}.`;
}

/** Warnings for app containers that restart or have restarted (MUP shows these in yellow). */
export function containerWarnings(rows: StatusRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const n = r.details?.restarts ?? 0;
    if (r.container === 'restarting') out.push(`The app container on "${r.server}" is restarting (restarted ${plural(n, 'time', 'times')}).`);
    else if (n > 0) out.push(`The app container on "${r.server}" has restarted ${plural(n, 'time', 'times')}.`);
  }
  return out;
}
