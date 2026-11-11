import { describe, expect, it } from 'vitest';
import { dockerStatus } from '../../../src/cli/commands/docker.js';
import type { CommandContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';

/** `docker status` against fake servers: `answers` maps a server to its exit code and stdout. */
function ctxWith(answers: Record<string, { code: number; stdout: string }>) {
  const lines: string[] = [];
  const commands: string[] = [];
  const ctx = {
    config: { servers: Object.fromEntries(Object.keys(answers).map((s) => [s, { host: `${s}.example` }])) },
    serverFilter: null,
    reporter: createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) }),
    ssh: { get: async (s: string) => ({ exec: async (cmd: string) => (commands.push(cmd), { ...answers[s], stderr: '' }) }) },
  } as unknown as CommandContext;
  return { ctx, out: () => lines.join(''), commands };
}

describe('docker status', () => {
  it('checks for the docker binary itself, since sudo answers 1 for a missing command', async () => {
    const c = ctxWith({ one: { code: 0, stdout: '27.5.1\n' } });
    await dockerStatus(c.ctx);
    expect(c.commands[0]).toMatch(/command -v docker/);
  });

  it('fails (exit 1) naming the servers without a usable Docker', async () => {
    const c = ctxWith({ one: { code: 0, stdout: '27.5.1\n' }, two: { code: 127, stdout: '' }, three: { code: 1, stdout: '' } });
    await expect(dockerStatus(c.ctx)).rejects.toThrow(/two, three/);
    expect(c.out()).toMatch(/two.*not installed/);
    expect(c.out()).toMatch(/three.*not running/);
  });
});
