import { describe, expect, it } from 'vitest';
import { cometScript } from '../../../src/remote/ops.js';
import { parseMongoState } from '../../../src/mongo/state.js';

describe('parseMongoState', () => {
  it('reads a server where MongoDB runs and an upgrade waits in the new script', () => {
    const out = ['set_up=1', 'new_version=7.0.14', 'current_version=6.0.13', 'same_script=0', 'running=1', 'container=abc123', 'fcv=6.0', 'replica_set=meteor', 'noise'].join('\n');
    expect(parseMongoState(out)).toEqual({ setUp: true, newVersion: '7.0.14', currentVersion: '6.0.13', sameScript: false, running: true, containerId: 'abc123', fcv: '6.0', replicaSet: 'meteor' });
  });

  it('reads a fresh server', () => {
    expect(parseMongoState('set_up=0\nrunning=0\nnew_version=\ncurrent_version=\ncontainer=\n')).toEqual({
      setUp: false,
      newVersion: null,
      currentVersion: null,
      sameScript: false,
      running: false,
      containerId: null,
      fcv: null,
      replicaSet: null,
    });
  });
});

describe('mongo-state.sh', () => {
  it('asks the running MongoDB for its FCV with the shell of the current version', async () => {
    const script = await cometScript('mongo-state.sh', {});
    expect(script).toContain('featureCompatibilityVersion');
    expect(script).toContain('mongo-start-current.sh');
    expect(script).toContain('rs.status().set');
    expect(script).toContain('cmp -s');
    // never fails on a missing file or container
    expect(script).not.toMatch(/^set -e/m);
  });
});
