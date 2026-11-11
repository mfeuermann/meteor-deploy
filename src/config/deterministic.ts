/**
 * Values MUP derives from seeded random numbers. They are reproduced bit for bit (same
 * `random-seed` version, same uuid construction) so a config shared by MUP and comet-deploy
 * gets the same load-balancing port and the same default build directory.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import randomSeed from 'random-seed';
import { v4 as uuidv4 } from 'uuid';

/** Host port MUP uses for load balancing: `random-seed(appName).intBetween(10000, 20000)`. */
export function lbPort(appName: string): number {
  return randomSeed.create(appName).intBetween(10000, 20000);
}

/**
 * MUP's default build directory, `<os.tmpdir()>/mup-meteor-<uuid>`, stable per absolute app
 * path: a v4 UUID whose 16 random bytes come from a generator seeded with the path.
 */
export function defaultBuildLocation(absAppPath: string): string {
  const rand = randomSeed.create(absAppPath);
  const bytes: number[] = [];
  // rand(255) yields 0..254, not 0..255; kept as is because MUP does the same.
  for (let i = 0; i < 16; i++) bytes.push(rand(255));
  return join(tmpdir(), `mup-meteor-${uuidv4({ random: bytes })}`);
}
