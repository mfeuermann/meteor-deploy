/**
 * A fake local `docker` CLI for unit tests of code that runs `docker` through src/local/exec.ts:
 * a bash script, first on PATH, that appends every call (`$*`) as one line to a log file and
 * answers as `script` says. `script` is bash run with the call's arguments; `$FAKE_DOCKER_LOG`
 * is the log path.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tempDir } from './fs.js';

export interface FakeDocker {
  /** Path of the call log. */
  log: string;
  /** The logged calls, one string per call. */
  calls(): string[];
  /** Puts PATH and FAKE_DOCKER_LOG back. */
  restore(): void;
}

export function fakeDocker(script: string): FakeDocker {
  const dir = tempDir();
  const log = join(dir, 'calls.log');
  const exe = join(dir, 'docker');
  writeFileSync(exe, `#!/bin/bash\necho "$*" >> "$FAKE_DOCKER_LOG"\n${script}\n`);
  chmodSync(exe, 0o755);
  const before = { path: process.env.PATH, log: process.env.FAKE_DOCKER_LOG };
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_DOCKER_LOG = log;
  return {
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    restore() {
      process.env.PATH = before.path;
      if (before.log === undefined) delete process.env.FAKE_DOCKER_LOG;
      else process.env.FAKE_DOCKER_LOG = before.log;
    },
  };
}
