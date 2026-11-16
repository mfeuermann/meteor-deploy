import { describe, expect, it } from 'vitest';
import { parseStatus, parseStatusDetails, type ServerDetails, type StatusRow } from '../../../src/cli/commands/status.js';
import { containerWarnings, dockerVersionWarning, formatStatusReport } from '../../../src/output/status-report.js';

// Local times, so the expected text does not depend on the time zone of the test run.
const STARTED = new Date(2026, 10, 16, 8, 12).toISOString();
const NOW = new Date(2026, 10, 16, 11, 16);

const DETAILS: ServerDetails = {
  os: 'Ubuntu 24.04.1 LTS',
  arch: 'x86_64',
  dockerRoot: '/var/lib/docker',
  // 18.2 GB in decimal units.
  dockerFreeKb: 17_773_568,
  startedAt: STARTED,
  restarts: 0,
  network: 'bridge',
  ports: ['127.0.0.1:3000 -> 3000/tcp'],
  envNames: ['MONGO_URL', 'METEOR_SETTINGS', 'PORT', 'ROOT_URL'],
  previousVersion: '20261115-170200-9f8e7d6',
  httpUrl: 'http://127.0.0.1:3000/',
  foreignVersion: false,
};
const ONE: StatusRow = { server: 'one', docker: '27.5.1', container: 'running', version: '20261116-081100-1a2b3c4', lock: null, http: 200, details: DETAILS };

const options = (o: Partial<Parameters<typeof formatStatusReport>[1]> = {}) => ({
  hostOf: (s: string) => ({ one: '203.0.113.10', two: '203.0.113.11' })[s] ?? s,
  localUrlOf: () => 'https://app.example.com/',
  fromHere: new Map([['https://app.example.com/', '200']]),
  behindProxy: false,
  now: NOW,
  ...o,
});

describe('formatStatusReport', () => {
  it('formats the spec example', () => {
    expect(formatStatusReport([ONE], options())).toBe(
      [
        '== one (203.0.113.10)',
        'Server:     Ubuntu 24.04.1 LTS, x86_64, Docker 27.5.1, 18.2 GB free in /var/lib/docker',
        'Container:  running since 2026-11-16 08:12 (3 h 4 min), restarted 0 times',
        'Version:    20261116-081100-1a2b3c4 (:previous 20261115-170200-9f8e7d6)',
        'Ports:      127.0.0.1:3000 -> 3000/tcp',
        'Env:        4 variables: MONGO_URL, METEOR_SETTINGS, PORT, ROOT_URL',
        'HTTP:       200 on the server (http://127.0.0.1:3000/), 200 from this computer (https://app.example.com/)',
      ].join('\n'),
    );
  });

  it('env values never appear', () => {
    // Only envname= lines count; a stray NAME=value line or a name with a value is ignored.
    const out = 'docker=27.5.1\ncontainer=running\nenvname=MONGO_URL\nMONGO_URL=mongodb://u:secret@h/db\nenvname=X=secret\nenvname=PORT\n';
    const row: StatusRow = { server: 'one', ...parseStatus(out), details: parseStatusDetails(out) };
    expect(row.details!.envNames).toEqual(['MONGO_URL', 'PORT']);
    const text = formatStatusReport([row], options());
    expect(text).toContain('Env:        2 variables: MONGO_URL, PORT');
    expect(text).not.toContain('secret');
  });

  it('foreign :latest says MUP deployed it', () => {
    const out = 'docker=27.5.1\ncontainer=running\nimage=latest sha256:mup\nimage=20261102-100000 sha256:2222\n';
    const row: StatusRow = { server: 'one', ...parseStatus(out), details: parseStatusDetails(out) };
    expect(row.details!.foreignVersion).toBe(true);
    expect(formatStatusReport([row], options())).toContain('Version:    not a comet-deploy version (MUP deployed it)');
  });

  it('unreachable server gets one line', () => {
    const two: StatusRow = { server: 'two', docker: 'unreachable', container: 'missing', version: null, lock: null, http: null, error: 'connect ETIMEDOUT' };
    expect(formatStatusReport([ONE, two], options()).split('\n\n')[1]).toBe('== two (203.0.113.11)\nunreachable: connect ETIMEDOUT');
  });

  it('a missing container, nothing published and no answer', () => {
    const missing: StatusRow = { server: 'one', ...parseStatus('docker=27.5.1\ncontainer=missing\n'), details: parseStatusDetails('docker=27.5.1\ncontainer=missing\n') };
    const text = formatStatusReport([missing], options({ fromHere: new Map([['https://app.example.com/', 'connection refused']]) }));
    expect(text).toContain('Container:  missing');
    expect(text).toContain('Version:    -');
    expect(text).toContain('HTTP:       not checked on the server (the app does not run), connection refused from this computer (https://app.example.com/)');
    const quiet: StatusRow = { ...ONE, details: { ...DETAILS, ports: [] } };
    expect(formatStatusReport([quiet], options({ behindProxy: true }))).toContain('Ports:      none published (behind the proxy)');
    expect(formatStatusReport([quiet], options())).toContain('Ports:      none published');
  });

  it('durations and counts', () => {
    const row = (startedAt: string, restarts: number): StatusRow => ({ ...ONE, details: { ...DETAILS, startedAt, restarts } });
    const line = (r: StatusRow) => formatStatusReport([r], options()).split('\n')[2];
    expect(line(row(new Date(2026, 10, 16, 11, 15, 40).toISOString(), 1))).toBe('Container:  running since 2026-11-16 11:15 (less than a minute), restarted 1 time');
    expect(line(row(new Date(2026, 10, 16, 10, 59).toISOString(), 2))).toBe('Container:  running since 2026-11-16 10:59 (17 min), restarted 2 times');
    expect(line(row(new Date(2026, 10, 13, 9, 0).toISOString(), 0))).toBe('Container:  running since 2026-11-13 09:00 (3 d 2 h), restarted 0 times');
  });
});

describe('warnings', () => {
  it('dockerVersionWarning', () => {
    const two: StatusRow = { ...ONE, server: 'two', docker: '26.1.4' };
    const three: StatusRow = { ...ONE, server: 'three' };
    expect(dockerVersionWarning([ONE, two, three])).toBe('The servers run different Docker versions: 27.5.1 (one, three), 26.1.4 (two).');
    expect(dockerVersionWarning([ONE, three])).toBeNull();
    expect(dockerVersionWarning([ONE, { ...two, docker: 'unreachable' }])).toBeNull();
  });

  it('containerWarnings', () => {
    const restarted: StatusRow = { ...ONE, details: { ...DETAILS, restarts: 3 } };
    const restarting: StatusRow = { ...ONE, server: 'two', container: 'restarting', details: { ...DETAILS, restarts: 5 } };
    expect(containerWarnings([ONE, restarted, restarting])).toEqual([
      'The app container on "one" has restarted 3 times.',
      'The app container on "two" is restarting (restarted 5 times).',
    ]);
  });
});
