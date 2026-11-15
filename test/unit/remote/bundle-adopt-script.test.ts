/**
 * Runs the rendered bundle-adopt.sh in a local bash against a fake `docker` (tags kept in a
 * state file, the app container described by env vars), a pass-through `sudo` and a no-op
 * `chown`, with a temp dir as the app directory.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from 'tar';
import { describe, expect, it } from 'vitest';
import { cometScript } from '../../../src/remote/ops.js';
import { tempDir } from '../../helpers/fs.js';

const FAKE_DOCKER = `#!/bin/bash
# state: one "<ref> <id>" line per tag. MOUNT: source of the container's /bundle mount;
# NO_CONTAINER: the app container does not exist; FAIL_COMMIT / FAIL_RMI: those commands fail.
echo "$*" >> "$DIR/calls"
state="$DIR/state"
resolve() { awk -v r="$1" '$1 == r { print $2 }' "$state"; }
settag() { grep -v "^$1 " "$state" > "$state.tmp"; mv "$state.tmp" "$state"; echo "$1 $2" >> "$state"; }
case "$1" in
  inspect)
    [ -n "$NO_CONTAINER" ] && exit 1
    case "$3" in
      *Mounts*) echo "$MOUNT" ;;
      *Image*) echo sha256:base ;;
    esac ;;
  image)
    id=$(resolve "$5"); [ -n "$id" ] || exit 1; echo "$id" ;;
  create) echo tmp1 ;;
  cp) cat > "$DIR/cp.tar" ;;
  commit)
    [ -n "$FAIL_COMMIT" ] && { echo "commit failed" >&2; exit 1; }
    settag "\${@: -1}" sha256:new ;;
  tag) settag "$3" "$(resolve "$2")" ;;
  rmi) [ -n "$FAIL_RMI" ] && exit 1; exit 0 ;;
  rm) exit 0 ;;
  *) exit 2 ;;
esac
`;

function fakeHost(tags: Record<string, string> = {}, o: { bundle?: boolean } = {}) {
  const dir = tempDir({ docker: FAKE_DOCKER, sudo: '#!/bin/bash\nexec "$@"\n', chown: '#!/bin/bash\nexit 0\n' });
  for (const f of ['docker', 'sudo', 'chown']) chmodSync(join(dir, f), 0o755);
  writeFileSync(join(dir, 'state'), Object.entries(tags).map(([r, id]) => `${r} ${id}\n`).join(''));
  const appDir = join(tempDir(), 'myapp');
  mkdirSync(join(appDir, 'current'), { recursive: true });
  mkdirSync(join(appDir, 'tmp'));
  if (o.bundle !== false) writeFileSync(join(appDir, 'current', 'bundle.tar.gz'), 'the MUP bundle');
  const run = async (env: Record<string, string> = {}) => {
    const script = await cometScript('bundle-adopt.sh', { appDir, container: 'myapp', repo: 'mup-myapp' });
    try {
      const stdout = execFileSync('bash', ['-s'], {
        input: script,
        // COPYFILE_DISABLE: macOS's tar would add AppleDouble (._*) entries; GNU tar on a server has none.
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DIR: dir, MOUNT: `${appDir}/current`, COPYFILE_DISABLE: '1', ...env },
        stdio: 'pipe',
      }).toString();
      return { code: 0, stdout };
    } catch (err) {
      return { code: (err as { status: number }).status, stdout: String((err as { stdout?: Buffer }).stdout ?? '') };
    }
  };
  const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);
  const tagsNow = () => Object.fromEntries(readFileSync(join(dir, 'state'), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')));
  return { dir, appDir, run, calls, tagsNow };
}

describe('bundle-adopt.sh', () => {
  it('takes over a container that runs the bundle from current', async () => {
    const h = fakeHost();
    const r = await h.run();
    expect(r).toEqual({ code: 0, stdout: 'adopted\n' });
    const calls = h.calls();
    expect(calls).toContain('create sha256:base');
    expect(calls).toContain('cp - tmp1:/');
    expect(calls).toContain('commit --change LABEL comet-deploy.bundle=1 tmp1 mup-myapp:latest');
    expect(calls).toContain('tag mup-myapp:latest mup-myapp:mup-bundle');
    expect(calls).toContain('rm -f tmp1');
    expect(h.tagsNow()).toMatchObject({ 'mup-myapp:latest': 'sha256:new', 'mup-myapp:mup-bundle': 'sha256:new' });
    const paths: string[] = [];
    await t({ file: join(h.dir, 'cp.tar'), onReadEntry: (e) => paths.push(e.path) });
    expect(paths).toEqual(['bundle/', 'bundle/bundle.tar.gz']);
    expect(existsSync(join(h.appDir, 'tmp', 'comet-bundle-adopt'))).toBe(false);
  });

  it('removes the image the old :mup-bundle tag pointed to', async () => {
    const h = fakeHost({ 'mup-myapp:mup-bundle': 'sha256:old' });
    expect((await h.run()).code).toBe(0);
    expect(h.calls()).toContain('rmi sha256:old');
    const failing = fakeHost({ 'mup-myapp:mup-bundle': 'sha256:old' });
    expect(await failing.run({ FAIL_RMI: '1' })).toEqual({ code: 0, stdout: 'adopted\n' });
  });

  it('does nothing without a /bundle mount', async () => {
    const h = fakeHost();
    expect(await h.run({ MOUNT: '' })).toEqual({ code: 0, stdout: '' });
    expect(h.calls().some((c) => c.startsWith('create'))).toBe(false);
  });

  it('does nothing for a mount from elsewhere', async () => {
    const h = fakeHost();
    expect(await h.run({ MOUNT: '/srv/x' })).toEqual({ code: 0, stdout: '' });
    expect(h.calls().some((c) => c.startsWith('create'))).toBe(false);
  });

  it('does nothing without current/bundle.tar.gz', async () => {
    const h = fakeHost({}, { bundle: false });
    expect(await h.run()).toEqual({ code: 0, stdout: '' });
    expect(h.calls().some((c) => c.startsWith('create'))).toBe(false);
  });

  it('does nothing without a container', async () => {
    const h = fakeHost();
    expect(await h.run({ NO_CONTAINER: '1' })).toEqual({ code: 0, stdout: '' });
    expect(h.calls().some((c) => c.startsWith('create'))).toBe(false);
  });

  it('cleans up when commit fails', async () => {
    const h = fakeHost({ 'mup-myapp:latest': 'sha256:keep' });
    const r = await h.run({ FAIL_COMMIT: '1' });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(h.calls()).toContain('rm -f tmp1');
    expect(existsSync(join(h.appDir, 'tmp', 'comet-bundle-adopt'))).toBe(false);
    expect(h.tagsNow()['mup-myapp:latest']).toBe('sha256:keep');
  });
});
