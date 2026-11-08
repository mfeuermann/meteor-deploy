import { tmpdir } from 'node:os';
import { join } from 'node:path';
import randomSeed from 'random-seed';
import { v4 as uuidv4 } from 'uuid';

/** Host port MUP uses for load balancing: `random-seed(appName).intBetween(10000, 20000)`. */
export function lbPort(appName: string): number {
  return randomSeed.create(appName).intBetween(10000, 20000);
}

/** MUP's default build directory, stable per absolute app path. */
export function defaultBuildLocation(absAppPath: string): string {
  const rand = randomSeed.create(absAppPath);
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(rand(255));
  return join(tmpdir(), `mup-meteor-${uuidv4({ random: bytes })}`);
}
