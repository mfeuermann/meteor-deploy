import yargs from 'yargs';
import { describe, expect, it } from 'vitest';
import { deployArgs, deployOptions } from '../../../src/cli/commands/deploy.js';

const parse = (args: string[]) => deployOptions(yargs()).parseSync(args) as Record<string, unknown>;

describe('deploy options', () => {
  it('collects repeated --cache-from and --cache-to for the image build', () => {
    const argv = parse(['--cache-from', 'type=gha,scope=a', '--cache-from', 'type=local,src=/c', '--cache-to', 'type=gha,mode=max,scope=a']);
    expect(deployArgs(argv)).toMatchObject({ cacheFrom: ['type=gha,scope=a', 'type=local,src=/c'], cacheTo: ['type=gha,mode=max,scope=a'] });
  });

  it('drops empty values, as from an unset CI variable, instead of passing them to buildx', () => {
    expect(deployArgs(parse(['--cache-from', '', '--cache-to=']))).toMatchObject({ cacheFrom: [], cacheTo: [] });
  });

  it('has no build cache import or export by default', () => {
    expect(deployArgs(parse([]))).toMatchObject({ cachedBuild: false, forceBuild: false, cacheFrom: [], cacheTo: [] });
  });
});
