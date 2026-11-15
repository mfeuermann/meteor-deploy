import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/fs.js';
import { CometError } from '../../../src/core/errors.js';
import { healthCheckScript, parseHealthResult } from '../../../src/deploy/health-check.js';

describe('parseHealthResult', () => {
  it('parses success', () => {
    expect(parseHealthResult('IP: 172.17.0.2\nCOMET_HEALTH ok 200 7')).toEqual({ ok: true, status: 200, seconds: 7 });
  });

  it('parses failures with and without a last status', () => {
    expect(parseHealthResult('COMET_HEALTH fail crashed - 3')).toEqual({ ok: false, reason: 'crashed', seconds: 3 });
    expect(parseHealthResult('COMET_HEALTH fail timeout 503 60\n')).toEqual({ ok: false, reason: 'timeout', lastStatus: 503, seconds: 60 });
  });

  it('throws when the script printed no result', () => {
    expect(() => parseHealthResult('garbage')).toThrow(CometError);
  });
});

describe('health-check.sh', () => {
  it('polls the container with curl and watches its state', async () => {
    const s = await healthCheckScript({ container: 'app', port: 3000, path: '/healthz', maxStatus: 499, timeoutSec: 60 });
    expect(s).toMatch(/curl[^\n]*-o \/dev\/null -w '%\{http_code\}'/);
    expect(s).toContain('--max-time');
    expect(s).toContain("'{{.State.Status}}'");
    expect(s).toContain("grep -q '\\[host'");
    expect(s).toContain('IP=localhost');
    expect(s).toContain("HC_PATH='/healthz'");
    expect(s).toContain('PORT=3000');
    expect(s).toContain('MAX_STATUS=499');
    expect(s).toContain('TIMEOUT=60');
  });

  it('rejects unsafe numbers and paths', async () => {
    await expect(healthCheckScript({ container: 'app', port: 0, path: '/', maxStatus: 499, timeoutSec: 60 })).rejects.toThrow(CometError);
    await expect(healthCheckScript({ container: 'app', port: 3000, path: 'no-slash', maxStatus: 499, timeoutSec: 60 })).rejects.toThrow(CometError);
  });
});

/**
 * Runs the rendered health-check.sh in a local bash with fake sudo (pass-through), docker
 * (a running container whose comet-deploy.bundle label is $LABEL), curl (no answer yet), sleep
 * (no-op) and date (5 s later on every call), and returns its result line.
 */
async function runHealthCheck(label: string, timeoutSec: number): Promise<string> {
  const bin = tempDir();
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const clock = join(bin, 'clock');
  writeFileSync(clock, '1000');
  fake('sudo', 'exec "$@"');
  fake('curl', 'echo 000; exit 7');
  fake('sleep', 'exit 0');
  fake('date', `n=$(cat ${clock}); echo $((n + 5)) > ${clock}; echo $n`);
  fake(
    'docker',
    `case "$*" in
  *comet-deploy.bundle*) echo "$LABEL" ;;
  *State.Status*) echo running ;;
  *Networks*) echo "map[bridge:0xc]" ;;
  *IPAddress*) echo 10.0.0.1 ;;
esac`,
  );
  const script = await healthCheckScript({ container: 'app', port: 3000, path: '/', maxStatus: 499, timeoutSec });
  const out = execFileSync('bash', ['-s'], { input: script, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LABEL: label } }).toString();
  return out.trim().split('\n').at(-1)!;
}

describe('health-check.sh in bundle mode', () => {
  const seconds = (line: string) => Number(/^COMET_HEALTH fail timeout - (\d+)$/.exec(line)?.[1]);

  it('adds 12 s for a container with the comet-deploy.bundle label', async () => {
    expect(seconds(await runHealthCheck('1', 10))).toBeGreaterThanOrEqual(22);
  });

  it('keeps the timeout for other containers', async () => {
    const s = seconds(await runHealthCheck('', 10));
    expect(s).toBeGreaterThanOrEqual(10);
    expect(s).toBeLessThan(22);
  });
});
