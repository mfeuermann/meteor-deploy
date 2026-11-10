import type { CometOptions } from '../config/types.js';
import type { ActivationResult } from './activate.js';

async function safe(server: string, fn: (s: string) => Promise<ActivationResult>): Promise<ActivationResult> {
  const start = Date.now();
  try {
    return await fn(server);
  } catch (err) {
    return { server, status: 'failed', durationMs: Date.now() - start, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * canary: the first server alone, then the rest in parallel (only if it is healthy);
 * rolling: one by one, stopping at the first unhealthy server; parallel: all at once.
 * After `signal` aborts no further server is started; those servers are `skipped`.
 */
export async function runStrategy(
  servers: string[],
  strategy: CometOptions['strategy'],
  fn: (s: string) => Promise<ActivationResult>,
  signal?: AbortSignal,
): Promise<{ results: ActivationResult[]; skipped: string[] }> {
  const results: ActivationResult[] = [];
  const stopped = () => !!signal?.aborted;
  if (strategy === 'parallel') {
    if (stopped()) return { results, skipped: [...servers] };
    return { results: await Promise.all(servers.map((s) => safe(s, fn))), skipped: [] };
  }
  if (strategy === 'rolling') {
    for (let i = 0; i < servers.length; i++) {
      if (stopped()) return { results, skipped: servers.slice(i) };
      const r = await safe(servers[i], fn);
      results.push(r);
      if (r.status !== 'healthy') return { results, skipped: servers.slice(i + 1) };
    }
    return { results, skipped: [] };
  }
  // canary
  if (servers.length === 0) return { results, skipped: [] };
  if (stopped()) return { results, skipped: [...servers] };
  const first = await safe(servers[0], fn);
  results.push(first);
  if (first.status !== 'healthy' || stopped()) return { results, skipped: servers.slice(1) };
  results.push(...(await Promise.all(servers.slice(1).map((s) => safe(s, fn)))));
  return { results, skipped: [] };
}
