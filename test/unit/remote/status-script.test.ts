/**
 * Runs the rendered status.sh in a local bash against a fake `docker`, `curl` and a
 * pass-through `sudo`. The container's env has values that must never leave the server.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cometScript } from '../../../src/remote/ops.js';
import { tempDir } from '../../helpers/fs.js';

const FAKE_DOCKER = `#!/bin/bash
# The container env; PEM spans three lines, like a private key in an env var.
ENV=('MONGO_URL=mongodb://u:secret@h/db' 'PORT=3000' $'PEM=-----BEGIN KEY-----\\nMIIsecretline\\n-----END KEY-----' 'http=999' 'lower-case=no')
case "$1" in
  version) echo 27.5.1 ;;
  info) echo "$DIR" ;;
  images) echo "image=20261116-081100-1a2b3c4 sha256:aaa"; echo "image=latest sha256:aaa" ;;
  inspect)
    case "$3" in
      *State.Status*) echo running ;;
      *StartedAt*) echo "2026-11-16T08:12:00.123456789Z 2" ;;
      *Config.Env*)
        # Emulates the Go template: names only with split, whole entries with println.
        for e in "\${ENV[@]}"; do
          case "$3" in *split*) echo "\${e%%=*}" ;; *println*) echo "$e" ;; esac
        done ;;
      *Ports*) echo "port=127.0.0.1:3000 -> 3000/tcp" ;;
      *index*) echo "map[bridge:0xc000123]" ;;
      *IPAddress*) echo 172.17.0.2 ;;
    esac ;;
esac
`;

async function run() {
  const dir = tempDir({ docker: FAKE_DOCKER, sudo: '#!/bin/bash\nexec "$@"\n', curl: '#!/bin/bash\nprintf 200\n' });
  for (const f of ['docker', 'sudo', 'curl']) chmodSync(join(dir, f), 0o755);
  const script = await cometScript('status.sh', { container: 'myapp', repo: 'mup-myapp', lockDir: join(dir, 'no-lock'), port: 3000, path: '/' });
  return execFileSync('bash', ['-s'], { input: script, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DIR: dir }, stdio: 'pipe' }).toString();
}

describe('status.sh', () => {
  it('prints names but not values of the container env', async () => {
    const out = await run();
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('envname='))).toEqual(['envname=MONGO_URL', 'envname=PORT', 'envname=PEM', 'envname=http']);
    // No part of a value, also not a line of a value that spans lines.
    expect(out).not.toContain('secret');
    expect(out).not.toContain('MIIsecretline');
    expect(out).not.toContain('999');
    expect(out).not.toContain('lower-case');
    expect(lines.filter((l) => l.startsWith('http='))).toEqual(['http=200']);
  });

  it('prints ports, started, restarts, network and the server facts', async () => {
    const lines = (await run()).split('\n');
    expect(lines).toContain('started=2026-11-16T08:12:00.123456789Z');
    expect(lines).toContain('restarts=2');
    expect(lines).toContain('port=127.0.0.1:3000 -> 3000/tcp');
    expect(lines).toContain('network=bridge');
    expect(lines).toContain('httpurl=http://172.17.0.2:3000/');
    expect(lines.some((l) => /^arch=\S+$/.test(l))).toBe(true);
    expect(lines.some((l) => /^dockerfree=\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('dockerroot=/'))).toBe(true);
    expect(lines.some((l) => l.startsWith('os='))).toBe(true);
  });
});
