import { describe, expect, it } from 'vitest';
import { CommandRunner, type HookExecutor } from '../../../src/core/runner.js';
import { hookTable, type HookHandler } from '../../../src/hooks/registry.js';

/** A runner whose executor records `name:handler` and can be told to throw for one name. */
function setup(hooks: Record<string, unknown>, o: { throwOn?: string; showHookNames?: boolean } = {}) {
  const events: string[] = [];
  const exec: HookExecutor = async (name: string, h: HookHandler) => {
    events.push(`${name}:${h.localCommand}`);
    if (name === o.throwOn) throw new Error(`hook ${name} failed`);
  };
  const runner = new CommandRunner({ hooks: hookTable(hooks), exec, ...(o.showHookNames ? { showHookNames: (l: string) => void events.push(l) } : {}) });
  return { runner, events };
}

const all = (...keys: string[]) => Object.fromEntries(keys.flatMap((k) => [[`pre.${k}`, { localCommand: 'x' }], [`post.${k}`, { localCommand: 'x' }]]));

describe('CommandRunner', () => {
  it('runs pre hooks, the step and post hooks in order', async () => {
    const { runner, events } = setup({ 'pre.deploy': { localCommand: 'a' }, 'pre.default.deploy': { localCommand: 'b' }, 'post.deploy': { localCommand: 'c' } });
    expect(await runner.run('default.deploy', async () => (events.push('step'), 3))).toBe(3);
    expect(events).toEqual(['pre.default.deploy:a', 'pre.default.deploy:b', 'step', 'post.default.deploy:c']);
    expect(runner.history).toEqual(['default.deploy']);
  });

  it('nested keys run their hooks inside the outer step', async () => {
    const { runner, events } = setup(all('default.deploy', 'meteor.deploy'));
    await runner.run('default.deploy', () => runner.run('meteor.deploy', async () => void events.push('step')));
    expect(events).toEqual(['pre.default.deploy:x', 'pre.meteor.deploy:x', 'step', 'post.meteor.deploy:x', 'post.default.deploy:x']);
    expect(runner.history).toEqual(['default.deploy', 'meteor.deploy']);
  });

  it('enter and leave span a non-lexical step', async () => {
    const { runner, events } = setup(all('meteor.push', 'meteor.build'));
    await runner.enter('meteor.push');
    await runner.run('meteor.build', async () => void events.push('build'));
    events.push('lock');
    await runner.leave('meteor.push');
    expect(events).toEqual(['pre.meteor.push:x', 'pre.meteor.build:x', 'build', 'post.meteor.build:x', 'lock', 'post.meteor.push:x']);
  });

  it('a throwing step runs no post hooks, here or outside', async () => {
    const { runner, events } = setup(all('default.deploy', 'meteor.deploy'));
    const failing = runner.run('default.deploy', () =>
      runner.run('meteor.deploy', async () => {
        throw new Error('boom');
      }),
    );
    await expect(failing).rejects.toThrow('boom');
    expect(events).toEqual(['pre.default.deploy:x', 'pre.meteor.deploy:x']);
    expect(runner.failed).toBe(true);
  });

  it('a failed result runs no post hooks', async () => {
    const { runner, events } = setup(all('default.deploy', 'meteor.start'));
    const r = await runner.run('default.deploy', () => runner.run('meteor.start', async () => ({ ok: false }), { failed: (x) => !x.ok }));
    expect(r).toEqual({ ok: false });
    expect(events).toEqual(['pre.default.deploy:x', 'pre.meteor.start:x']);
  });

  it('after a failure no hook runs, but keys are still recorded', async () => {
    const { runner, events } = setup(all('meteor.start', 'meteor.stop'));
    runner.markFailed();
    await runner.run('meteor.stop', async () => void events.push('stop'));
    expect(events).toEqual(['stop']);
    expect(runner.history).toEqual(['meteor.stop']);
  });

  it('a failing hook fails the step before it runs', async () => {
    const { runner, events } = setup(all('meteor.start'), { throwOn: 'pre.meteor.start' });
    await expect(runner.run('meteor.start', async () => void events.push('start'))).rejects.toThrow('hook pre.meteor.start failed');
    expect(events).toEqual(['pre.meteor.start:x']);
    expect(runner.failed).toBe(true);
  });

  it('a failing post hook fails the command and stops the outer post hooks', async () => {
    const { runner, events } = setup(all('default.deploy', 'meteor.deploy'), { throwOn: 'post.meteor.deploy' });
    await expect(runner.run('default.deploy', () => runner.run('meteor.deploy', async () => void events.push('step')))).rejects.toThrow('post.meteor.deploy');
    expect(events).toEqual(['pre.default.deploy:x', 'pre.meteor.deploy:x', 'step', 'post.meteor.deploy:x']);
  });

  it('prints Hook: lines for every key when showHookNames is set', async () => {
    const { runner, events } = setup({}, { showHookNames: true });
    await runner.run('default.restart', () => runner.run('meteor.restart', async () => void events.push('step')));
    expect(events).toEqual(['Hook: pre.default.restart', 'Hook: pre.meteor.restart', 'step', 'Hook: post.meteor.restart', 'Hook: post.default.restart']);
  });

  it('prints no post line after a failure', async () => {
    const { runner, events } = setup({}, { showHookNames: true });
    await expect(
      runner.run('meteor.start', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();
    expect(events).toEqual(['Hook: pre.meteor.start']);
  });

  it('is a plain recorder without hooks', async () => {
    const runner = new CommandRunner();
    expect(await runner.run('default.deploy', async () => 4)).toBe(4);
    expect(runner.history).toEqual(['default.deploy']);
  });
});
