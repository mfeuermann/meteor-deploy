/**
 * What the rollout commands (`deploy`, `reconfig`, `restart`, `rollback`) share: the
 * `--strategy` / `--force-unlock` options and the check that every server ended healthy.
 */
import type { Argv } from 'yargs';
import type { Strategy } from '../config/types.js';
import { CometError } from '../core/errors.js';
import type { ActivationResult } from '../deploy/activate.js';

const STRATEGIES: Strategy[] = ['canary', 'rolling', 'parallel'];

/** Adds `--strategy` and `--force-unlock`. */
export const rolloutOptions = (y: Argv): Argv =>
  y
    .option('strategy', { type: 'string', choices: STRATEGIES, describe: 'Rollout strategy (default: cometDeploy.strategy)' })
    .option('force-unlock', { type: 'boolean', describe: 'Release an existing deploy lock first' });

/** The parsed `--strategy` / `--force-unlock` values. */
export function rolloutArgs(argv: Record<string, unknown>): { strategy: Strategy | undefined; forceUnlock: boolean } {
  return { strategy: argv.strategy as Strategy | undefined, forceUnlock: !!argv['force-unlock'] };
}

/**
 * Throws a `CometError` ("<what> did not complete on: …") naming every server that did not end
 * healthy (failed or reverted) or was skipped.
 */
export function assertAllHealthy(what: string, o: { results: Array<Pick<ActivationResult, 'server' | 'status'>>; skipped: string[] }): void {
  const bad = [...o.results.filter((r) => r.status !== 'healthy').map((r) => r.server), ...o.skipped];
  if (bad.length) throw new CometError(`${what} did not complete on: ${bad.join(', ')}`);
}
