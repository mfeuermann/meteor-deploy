import { describe, expect, it } from 'vitest';
import { buildxArgs } from '../../../src/local/docker.js';

describe('buildxArgs', () => {
  const base = { contextDir: '/ctx', platform: 'linux/amd64', tag: 'app:1', buildArgs: { NODE_VERSION: '24' }, labels: { l: 'v' } };

  it('passes each cache import and export to buildx, before the build context', () => {
    const args = buildxArgs({ ...base, cacheFrom: ['type=gha,scope=a', 'type=local,src=/c'], cacheTo: ['type=gha,mode=max,scope=a'] });
    expect(args.slice(-7)).toEqual(['--cache-from', 'type=gha,scope=a', '--cache-from', 'type=local,src=/c', '--cache-to', 'type=gha,mode=max,scope=a', '/ctx']);
  });

  it('adds no cache flags without them', () => {
    expect(buildxArgs(base)).toEqual([
      'buildx', 'build', '--load', '--progress', 'plain', '--platform', 'linux/amd64', '-t', 'app:1', '-f', '-',
      '--build-arg', 'NODE_VERSION=24', '--label', 'l=v', '/ctx',
    ]);
  });
});
