import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { makeHistoryEntry, mergeHistory } from '../../../src/deploy/history.js';
import type { HistoryEntry } from '../../../src/remote/ops.js';

const e = (p: Partial<HistoryEntry>): HistoryEntry => ({
  version: 'v1',
  action: 'deploy',
  result: 'success',
  startedAt: '2026-11-07T10:00:00.000Z',
  durationMs: 1,
  user: 'u',
  machine: 'm',
  servers: ['one', 'two'],
  tool: 'comet-deploy@0.1.0',
  ...p,
});

describe('makeHistoryEntry', () => {
  it('fills user, machine and tool', () => {
    const h = makeHistoryEntry({
      action: 'deploy',
      version: '20261107-183005',
      result: 'success',
      startedAt: new Date('2026-11-07T18:30:05Z'),
      durationMs: 1200,
      git: { sha: 'abc', branch: 'main', dirty: false },
      servers: ['one'],
    });
    expect(h).toMatchObject({ version: '20261107-183005', startedAt: '2026-11-07T18:30:05.000Z', machine: hostname(), git: { commit: 'abc', branch: 'main', dirty: false } });
    expect(h.user.length).toBeGreaterThan(0);
    expect(h.tool).toMatch(/^comet-deploy@\d/);
  });

  it('omits git when unknown', () => {
    const h = makeHistoryEntry({ action: 'restart', version: null, result: 'success', startedAt: new Date(), durationMs: 1, git: null, servers: [] });
    expect(h.git).toBeUndefined();
  });
});

describe('mergeHistory', () => {
  it('merges identical entries from several servers and sorts newest first', () => {
    const merged = mergeHistory(
      {
        one: [e({}), e({ startedAt: '2026-11-08T10:00:00.000Z', version: 'v2' })],
        two: [e({ result: 'reverted' }), e({ startedAt: '2026-11-06T10:00:00.000Z', version: 'v0' })],
      },
      10,
    );
    expect(merged.map((m) => m.version)).toEqual(['v2', 'v1', 'v0']);
    expect(merged[1].reportedBy).toEqual(['one', 'two']);
    expect(merged[0].reportedBy).toEqual(['one']);
  });

  it('applies the limit', () => {
    expect(mergeHistory({ one: [e({ version: 'a' }), e({ version: 'b', startedAt: '2026-11-09T00:00:00.000Z' })] }, 1).map((m) => m.version)).toEqual(['b']);
  });
});
