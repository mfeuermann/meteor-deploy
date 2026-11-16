/**
 * Runs the rendered debug-start.sh in a local bash against a fake `docker` and a pass-through
 * `sudo` (pattern of bundle-adopt-script.test.ts). The fake records its calls; env vars
 * describe the app container.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEBUG_IMAGE, DEBUG_PORT_IN_APP } from '../../../src/remote/debug.js';
import { cometScript } from '../../../src/remote/ops.js';
import { tempDir } from '../../helpers/fs.js';

const FAKE_DOCKER = `#!/bin/bash
# RUNNING: true|false; NET: name of the container's network (host, bridge, …); IP, GW: its
# address and gateway; NO_NODE: no node process; FAIL_RUN: docker run fails.
echo "$*" >> "$DIR/calls"
case "$1" in
  inspect)
    case "$3" in
      *State.Running*) echo "\${RUNNING:-true} cid123" ;;
      *index*) echo "map[\${NET:-bridge}:0xc000123]" ;;
      *range*) echo "$IP $GW" ;;
    esac ;;
  exec) [ -n "$NO_NODE" ] && { echo "no node process in the container" >&2; exit 1; }; exit 0 ;;
  rm) exit 0 ;;
  run) [ -n "$FAIL_RUN" ] && { echo "pull access denied for alpine/socat" >&2; exit 125; }; echo helperid ;;
  *) exit 2 ;;
esac
`;

async function runScript(env: Record<string, string> = {}) {
  const dir = tempDir({ docker: FAKE_DOCKER, sudo: '#!/bin/bash\nexec "$@"\n' });
  for (const f of ['docker', 'sudo']) chmodSync(join(dir, f), 0o755);
  const script = await cometScript('debug-start.sh', { container: 'myapp', helper: 'myapp-debug', image: DEBUG_IMAGE, listenPort: DEBUG_PORT_IN_APP });
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', ['-s'], { input: script, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DIR: dir, IP: '172.18.0.5', GW: '172.18.0.1', ...env }, stdio: 'pipe' }).toString();
  } catch (err) {
    const e = err as { status: number; stdout?: Buffer; stderr?: Buffer };
    code = e.status;
    stdout = String(e.stdout ?? '');
    stderr = String(e.stderr ?? '');
  }
  // The script given to `docker exec … sh -c` spans several lines, so `log` keeps the raw text.
  const log = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  const calls = log.trim().split('\n').filter(Boolean);
  return { code, stdout, stderr, calls, log };
}

describe('debug-start.sh', () => {
  it('bridge: kills USR1 in the app and starts a listening helper limited to the gateway', async () => {
    const r = await runScript();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('network=bridge\nip=172.18.0.5\ngateway=172.18.0.1\nid=cid123\n');
    expect(r.log).toMatch(/^exec myapp sh -c pid=\$\(pidof -s node[\s\S]*kill -s USR1 "\$pid"$/m);
    expect(r.calls).toContain('rm -f myapp-debug');
    expect(r.calls).toContain(
      'run -d --rm --name myapp-debug --network container:myapp alpine/socat:1.8.1.1 TCP-LISTEN:9228,fork,reuseaddr,range=172.18.0.1/32 TCP:127.0.0.1:9229',
    );
    // The inspector is enabled before the helper starts.
    expect(r.log.indexOf('kill -s USR1')).toBeLessThan(r.log.indexOf('\nrun -d'));
  });

  it('host network: the helper only sleeps', async () => {
    const r = await runScript({ NET: 'host' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('network=host\nid=cid123\n');
    expect(r.calls).toContain('run -d --rm --name myapp-debug --network host --entrypoint sleep alpine/socat:1.8.1.1 infinity');
  });

  it('not running exits 10 before anything else', async () => {
    const r = await runScript({ RUNNING: 'false' });
    expect(r.code).toBe(10);
    expect(r.calls.filter((c) => !c.startsWith('inspect'))).toEqual([]);
  });

  it('no node process exits 11', async () => {
    const r = await runScript({ NO_NODE: '1' });
    expect(r.code).toBe(11);
    expect(r.stderr).toContain('no node process in the container');
    expect(r.calls.some((c) => c.startsWith('run'))).toBe(false);
  });

  it('a helper that cannot start exits 12 with docker run\'s output', async () => {
    const r = await runScript({ FAIL_RUN: '1' });
    expect(r.code).toBe(12);
    expect(r.stderr).toContain('pull access denied for alpine/socat');
  });

  it('a container without an address exits 12', async () => {
    const r = await runScript({ IP: '', GW: '' });
    expect(r.code).toBe(12);
    expect(r.stderr).toContain('has no IP address');
    expect(r.calls.some((c) => c.startsWith('run'))).toBe(false);
  });
});
