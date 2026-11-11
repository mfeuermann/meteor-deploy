import { describe, expect, it } from 'vitest';
import { CommandRunner } from '../../../src/core/runner.js';
import { CometError } from '../../../src/core/errors.js';

describe('CommandRunner and MUP hooks (I5: never skip a hook silently)', () => {
  it('refuses to run a command that has a pre/post hook (hooks are phase 2)', async () => {
    const r = new CommandRunner({ 'pre.deploy': { localCommand: 'backup' }, 'post.meteor.restart': {} });
    await expect(r.run('default.deploy', async () => 1)).rejects.toThrow(CometError);
    await expect(r.run('default.deploy', async () => 1)).rejects.toThrow(/pre\.deploy.*phase 2/);
    await expect(r.run('meteor.restart', async () => 1)).rejects.toThrow(/post\.meteor\.restart/);
    expect(await r.run('meteor.deploy', async () => 2)).toBe(2);
  });

  it('accepts the long form pre.default.<command> too', async () => {
    const r = new CommandRunner({ 'pre.default.reconfig': {} });
    await expect(r.run('default.reconfig', async () => 1)).rejects.toThrow(/pre\.default\.reconfig/);
  });

  it('refuses a list of keys up front, before any of them runs', () => {
    const r = new CommandRunner({ 'post.meteor.start': {} });
    expect(() => r.refuseHooks(['meteor.push', 'meteor.start'])).toThrow(/post\.meteor\.start/);
    expect(() => r.refuseHooks(['meteor.push'])).not.toThrow();
    expect(r.history).toEqual([]);
  });

  it('runs without hooks', async () => {
    expect(await new CommandRunner().run('default.deploy', async () => 3)).toBe(3);
    expect(await new CommandRunner({}).run('default.deploy', async () => 4)).toBe(4);
  });
});
