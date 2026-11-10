import { describe, expect, it } from 'vitest';
import { formatStatusTable, parseStatus } from '../../../src/cli/commands/status.js';

const ID3 = 'sha256:3333';
const ID2 = 'sha256:2222';

describe('parseStatus', () => {
  it('reads a running app with a kept version, a lock and an HTTP answer', () => {
    const out = [
      'docker=27.5.1',
      'container=running',
      `image=20261103-100000 ${ID3}`,
      `image=20261102-100000 ${ID2}`,
      `image=latest ${ID3}`,
      `image=previous ${ID2}`,
      'lock={"user":"eve","machine":"box","pid":1,"startedAt":"2026-11-08T10:00:00.000Z","command":"deploy","tool":"t"}',
      'http=200',
    ].join('\n');
    expect(parseStatus(out)).toEqual({ docker: '27.5.1', container: 'running', version: '20261103-100000', lock: 'eve@box ("deploy" since 2026-11-08T10:00:00.000Z)', http: 200 });
  });

  it('handles a stopped / missing / restarting app, no lock and no answer', () => {
    expect(parseStatus('docker=27.5.1\ncontainer=exited\nhttp=000\n')).toEqual({ docker: '27.5.1', container: 'stopped', version: null, lock: null, http: null });
    expect(parseStatus('docker=27.5.1\ncontainer=missing\n').container).toBe('missing');
    expect(parseStatus('docker=27.5.1\ncontainer=restarting\n').container).toBe('restarting');
    expect(parseStatus('docker=not-installed\ncontainer=missing\n').docker).toBe('not-installed');
  });

  it('a :latest that is no kept version (deployed by MUP) has no version', () => {
    expect(parseStatus(`docker=27.5.1\ncontainer=running\nimage=latest sha256:mup\nimage=20261102-100000 ${ID2}\n`).version).toBeNull();
  });

  it('an unreadable lock still shows that the server is locked', () => {
    expect(parseStatus('docker=27.5.1\ncontainer=running\nlock=garbage\n').lock).toBe('held (owner unknown)');
  });
});

describe('formatStatusTable', () => {
  it('prints one row per server', () => {
    const t = formatStatusTable([
      { server: 'one', docker: '27.5.1', container: 'running', version: '20261103-100000', lock: null, http: 200 },
      { server: 'two', docker: 'not-running', container: 'missing', version: null, lock: 'eve@box', http: null },
    ]);
    const lines = t.split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['SERVER', 'DOCKER', 'APP', 'VERSION', 'HTTP', 'LOCK']);
    expect(lines[1]).toMatch(/^one\s+27\.5\.1\s+running\s+20261103-100000\s+200$/);
    expect(lines[2]).toMatch(/^two\s+not-running\s+missing\s+-\s+-\s+eve@box$/);
  });
});
