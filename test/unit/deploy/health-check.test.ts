import { describe, expect, it } from 'vitest';
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
