import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBuildLocation, lbPort } from '../../../src/config/deterministic.js';

describe('lbPort (MUP test vectors)', () => {
  it.each([
    ['app', 19157],
    ['myapp', 18442],
    ['staging', 11399],
    ['production', 17499],
    ['Wekan', 10318],
  ])('%s → %d', (name, port) => {
    expect(lbPort(name)).toBe(port);
  });
});

describe('defaultBuildLocation (MUP test vectors)', () => {
  it('matches /home/u/myapp', () => {
    expect(defaultBuildLocation('/home/u/myapp')).toBe(join(tmpdir(), 'mup-meteor-b5af117c-b68e-49a5-ae1c-0877b574ddbb'));
  });
  it('matches /Users/me/app', () => {
    expect(defaultBuildLocation('/Users/me/app')).toBe(join(tmpdir(), 'mup-meteor-3eaabbe3-e2b0-497d-8456-b27d10a37804'));
  });
});
