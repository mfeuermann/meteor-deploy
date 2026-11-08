import { describe, expect, it } from 'vitest';
import { appDir, containerName, imageRepo, localImageRepo } from '../../../src/core/naming.js';
import type { NormalizedConfig } from '../../../src/config/types.js';

const cfg = (extra: Partial<NormalizedConfig> = {}) => ({ app: { name: 'My.App' }, ...extra }) as unknown as NormalizedConfig;

describe('naming', () => {
  it('lowercases the image but keeps container and dir names', () => {
    expect(imageRepo(cfg())).toBe('mup-my.app');
    expect(localImageRepo(cfg())).toBe('mup-my.app');
    expect(containerName(cfg())).toBe('My.App');
    expect(appDir(cfg())).toBe('/opt/My.App');
  });

  it('prefixes the registry image only', () => {
    const c = cfg({ privateDockerRegistry: { host: 'reg.io', imagePrefix: 'reg.io/team' } });
    expect(imageRepo(c)).toBe('reg.io/team/mup-my.app');
    expect(localImageRepo(c)).toBe('mup-my.app');
  });
});
