import { describe, expect, it } from 'vitest';
import { pickServer } from '../../../src/cli/pick-server.js';
import { CometError } from '../../../src/core/errors.js';

const usage = 'comet-deploy ssh <server>';
const pick = (words: string[], candidates: string[], wordsMayBeCommand = true) => pickServer({ words, candidates, usage, wordsMayBeCommand });
const fails = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CometError);
    return (e as CometError).message;
  }
  throw new Error('expected a CometError');
};

describe('pickServer', () => {
  it('first word that is a server picks it', () => {
    expect(pick(['two', 'ls'], ['one', 'two'])).toEqual({ server: 'two', rest: ['ls'] });
  });

  it('no words and one candidate', () => {
    expect(pick([], ['one'])).toEqual({ server: 'one', rest: [] });
  });

  it('no words and two candidates throws Choose a server', () => {
    expect(fails(() => pick([], ['one', 'two']))).toBe('Choose a server: comet-deploy ssh <server>. Servers: one, two');
  });

  it('unknown first word with one candidate is part of the command when wordsMayBeCommand', () => {
    expect(pick(['uptime'], ['one'])).toEqual({ server: 'one', rest: ['uptime'] });
    expect(pick(['uptime', '-p'], ['one'])).toEqual({ server: 'one', rest: ['uptime', '-p'] });
  });

  it('unknown first word throws Unknown server', () => {
    expect(fails(() => pick(['three'], ['one', 'two']))).toBe('Unknown server "three". Servers: one, two');
    expect(fails(() => pick(['three'], ['one'], false))).toBe('Unknown server "three". Servers: one');
  });
});
