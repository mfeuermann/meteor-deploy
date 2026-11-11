/**
 * Runs the rendered retag.sh in a local bash against a fake `docker` (tags kept in a state
 * file) and a pass-through `sudo`, to check what the script leaves behind when a step fails.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cometScript } from '../../../src/remote/ops.js';
import { tempDir } from '../../helpers/fs.js';

const FAKE_DOCKER = `#!/bin/bash
# state: one "<ref> <id>" line per tag; FAIL_TAG makes "docker tag ... <FAIL_TAG>" fail
state="$STATE"
resolve() { awk -v r="$1" '$1 == r { print $2 }' "$state"; }
case "$1" in
  image)
    id=$(resolve "$5")
    [ -n "$id" ] || exit 1
    echo "$id" ;;
  tag)
    [ "$3" = "$FAIL_TAG" ] && { echo "tag failed" >&2; exit 1; }
    id=$(resolve "$2"); [ -n "$id" ] || id="$2"
    grep -v "^$3 " "$state" > "$state.tmp"; mv "$state.tmp" "$state"
    echo "$3 $id" >> "$state" ;;
  rmi)
    grep -v "^$2 " "$state" > "$state.tmp"; mv "$state.tmp" "$state" ;;
  *) exit 2 ;;
esac
`;

function fakeHost(tags: Record<string, string>) {
  const dir = tempDir({ docker: FAKE_DOCKER, sudo: '#!/bin/bash\nexec "$@"\n' });
  chmodSync(join(dir, 'docker'), 0o755);
  chmodSync(join(dir, 'sudo'), 0o755);
  const state = join(dir, 'state');
  writeFileSync(state, Object.entries(tags).map(([r, id]) => `${r} ${id}\n`).join(''));
  const run = (script: string, env: Record<string, string> = {}) => {
    try {
      execFileSync('bash', ['-s'], { input: script, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STATE: state, ...env }, stdio: 'pipe' });
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  };
  const read = () => Object.fromEntries(readFileSync(state, 'utf8').trim().split('\n').map((l) => l.split(' ')));
  return { run, read };
}

describe('retag.sh activate', () => {
  const tags = { 'mup-app:latest': 'sha256:b', 'mup-app:previous': 'sha256:a', 'mup-app:20261111-100000': 'sha256:c' };

  it('moves latest to previous and the version to latest', async () => {
    const h = fakeHost(tags);
    expect(h.run(await cometScript('retag.sh', { mode: 'activate', repo: 'mup-app', version: '20261111-100000' }))).toBe(0);
    expect(h.read()).toMatchObject({ 'mup-app:latest': 'sha256:c', 'mup-app:previous': 'sha256:b' });
  });

  it('puts :previous back when moving :latest fails, so both tags are as before', async () => {
    const h = fakeHost(tags);
    const code = h.run(await cometScript('retag.sh', { mode: 'activate', repo: 'mup-app', version: '20261111-100000' }), { FAIL_TAG: 'mup-app:latest' });
    expect(code).not.toBe(0);
    expect(h.read()).toMatchObject({ 'mup-app:latest': 'sha256:b', 'mup-app:previous': 'sha256:a' });
  });

  it('removes a :previous it created when there was none before', async () => {
    const h = fakeHost({ 'mup-app:latest': 'sha256:b', 'mup-app:20261111-100000': 'sha256:c' });
    const code = h.run(await cometScript('retag.sh', { mode: 'activate', repo: 'mup-app', version: '20261111-100000' }), { FAIL_TAG: 'mup-app:latest' });
    expect(code).not.toBe(0);
    expect(h.read()['mup-app:previous']).toBeUndefined();
    expect(h.read()['mup-app:latest']).toBe('sha256:b');
  });
});
