import { describe, expect, it } from 'vitest';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { runStrategy } from '../../../src/deploy/strategy.js';

function recorder(outcome: Record<string, ActivationResult['status']> = {}) {
  const log: Array<{ s: string; start: number; end: number }> = [];
  let t = 0;
  const fn = async (s: string): Promise<ActivationResult> => {
    const entry = { s, start: t++, end: -1 };
    log.push(entry);
    await new Promise((r) => setTimeout(r, 5));
    entry.end = t++;
    return { server: s, status: outcome[s] ?? 'healthy', durationMs: 5 };
  };
  return { fn, log, get: (s: string) => log.find((l) => l.s === s)! };
}

describe('runStrategy', () => {
  it('canary: first alone, then the rest together', async () => {
    const r = recorder();
    const out = await runStrategy(['a', 'b', 'c'], 'canary', r.fn);
    expect(out.results.map((x) => x.server)).toEqual(['a', 'b', 'c']);
    expect(r.get('b').start).toBeGreaterThan(r.get('a').end);
    expect(r.get('c').start).toBeLessThan(r.get('b').end);
    expect(r.get('b').start).toBeLessThan(r.get('c').end);
    expect(out.skipped).toEqual([]);
  });

  it('canary: a reverted canary skips the others', async () => {
    const r = recorder({ a: 'reverted' });
    const out = await runStrategy(['a', 'b', 'c'], 'canary', r.fn);
    expect(out.results.map((x) => x.server)).toEqual(['a']);
    expect(out.skipped).toEqual(['b', 'c']);
  });

  it('rolling: one by one, stops at the first failure', async () => {
    const r = recorder({ b: 'failed' });
    const out = await runStrategy(['a', 'b', 'c'], 'rolling', r.fn);
    expect(r.get('b').start).toBeGreaterThan(r.get('a').end);
    expect(out.results.map((x) => x.status)).toEqual(['healthy', 'failed']);
    expect(out.skipped).toEqual(['c']);
  });

  it('parallel: all at once, results in server order', async () => {
    const r = recorder({ b: 'reverted' });
    const out = await runStrategy(['a', 'b', 'c'], 'parallel', r.fn);
    for (const x of ['a', 'b', 'c']) for (const y of ['a', 'b', 'c']) expect(r.get(x).start).toBeLessThan(r.get(y).end);
    expect(out.results.map((x) => x.server)).toEqual(['a', 'b', 'c']);
    expect(out.skipped).toEqual([]);
  });

  it('turns a thrown error into a failed result', async () => {
    const out = await runStrategy(['a'], 'parallel', async () => {
      throw new Error('boom');
    });
    expect(out.results[0]).toMatchObject({ server: 'a', status: 'failed', error: 'boom' });
  });
});
