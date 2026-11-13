import { describe, expect, it } from 'vitest';
import type { NormalizedConfig, RegistryConfig } from '../../../src/config/types.js';
import { assertRegistryPushable, registryOfHost, registryOfPrefix, registryRepo, usesRegistry } from '../../../src/transfer/registry.js';

const config = (reg?: RegistryConfig) => ({ app: { name: 'MyApp' }, privateDockerRegistry: reg }) as unknown as NormalizedConfig;

describe('registry naming', () => {
  it.each([
    ['reg.example.com', 'reg.example.com'],
    ['https://REG.example.com/', 'reg.example.com'],
    ['reg.example.com:5000', 'reg.example.com:5000'],
    ['https://index.docker.io/v1/', 'docker.io'],
    ['registry-1.docker.io', 'docker.io'],
    ['docker.io', 'docker.io'],
  ])('registryOfHost(%s) = %s', (host, expected) => {
    expect(registryOfHost(host)).toBe(expected);
  });

  it.each([
    ['reg.example.com/team', 'reg.example.com'],
    ['127.0.0.1:5000/x', '127.0.0.1:5000'],
    ['localhost/x', 'localhost'],
    ['REG.example.com/team', 'reg.example.com'],
    ['myteam', 'docker.io'],
    ['myteam/sub', 'docker.io'],
  ])('registryOfPrefix(%s) = %s', (prefix, expected) => {
    expect(registryOfPrefix(prefix)).toBe(expected);
  });

  it('registryRepo is <imagePrefix>/mup-<lowercase app name>', () => {
    expect(registryRepo(config({ host: 'reg.example.com', imagePrefix: 'reg.example.com/team' }))).toBe('reg.example.com/team/mup-myapp');
  });

  it('usesRegistry follows privateDockerRegistry', () => {
    expect(usesRegistry(config({ host: 'reg.example.com' }))).toBe(true);
    expect(usesRegistry(config())).toBe(false);
  });
});

describe('assertRegistryPushable', () => {
  it.each([
    [{ host: 'reg.example.com', imagePrefix: 'reg.example.com/team' }],
    [{ host: 'https://reg.example.com/', imagePrefix: 'REG.example.com/team' }],
    [{ host: 'https://index.docker.io/v1/', imagePrefix: 'user' }],
    [{ host: 'docker.io', imagePrefix: 'user' }],
    [{ host: '127.0.0.1:5000', imagePrefix: '127.0.0.1:5000/comet' }],
  ])('accepts %j', (reg) => {
    expect(() => assertRegistryPushable(config(reg))).not.toThrow();
  });

  it('does nothing without a registry', () => {
    expect(() => assertRegistryPushable(config())).not.toThrow();
  });

  it('requires imagePrefix', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com' }))).toThrow(
      'privateDockerRegistry.imagePrefix is required: it is where comet-deploy pushes the image, for example "registry.example.com/myteam".',
    );
  });

  it('refuses a prefix that would push to Docker Hub', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com', imagePrefix: 'myteam' }))).toThrow(
      'privateDockerRegistry.imagePrefix "myteam" would push to docker.io, not to the registry "reg.example.com" in privateDockerRegistry.host. Start it with the registry host, for example "reg.example.com/myteam".',
    );
  });

  it('refuses a prefix on another port of the same host', () => {
    expect(() => assertRegistryPushable(config({ host: 'reg.example.com', imagePrefix: 'reg.example.com:5000/t' }))).toThrow(
      'would push to reg.example.com:5000, not to the registry "reg.example.com"',
    );
  });
});
