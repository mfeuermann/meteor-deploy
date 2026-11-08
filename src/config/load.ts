import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CometError } from '../core/errors.js';
import type { RawConfig } from './types.js';

export interface LoadedConfig {
  configPath: string;
  basePath: string;
  raw: RawConfig;
}

const require = createRequire(import.meta.url);

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** `--config` (relative to cwd), else `./mup.js`, else `./mup.json`. */
export function findConfigFile(cwd: string, configFlag?: string): string {
  if (configFlag) {
    const p = resolve(cwd, expandTilde(configFlag));
    if (!existsSync(p)) throw new CometError(`Config file not found: ${p}`);
    return p;
  }
  for (const name of ['mup.js', 'mup.json']) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  throw new CometError(`"mup.js" or "mup.json" not found in ${cwd}.`, {
    hint: 'Run "comet-deploy init" to create one, or pass --config <path>.',
  });
}

function loadFile(path: string): RawConfig {
  if (path.endsWith('.json')) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new CometError(`Cannot read ${path}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new CometError(`Invalid JSON in ${path}: ${(err as Error).message}`);
    }
  }
  try {
    const resolved = require.resolve(path);
    delete require.cache[resolved];
    const mod = require(resolved);
    return (mod && mod.__esModule && mod.default) || mod;
  } catch (err) {
    throw new CometError(`Failed to load ${path}: ${(err as Error).message}`, { cause: err });
  }
}

export function loadConfig(cwd: string, configFlag?: string): LoadedConfig {
  const configPath = findConfigFile(cwd, configFlag);
  // Same as MUP: base path is the --config directory, otherwise cwd.
  const basePath = configFlag ? dirname(configPath) : cwd;
  const raw = loadFile(configPath);
  if (!raw || typeof raw !== 'object') throw new CometError(`${configPath} must export an object.`);
  return { configPath, basePath, raw };
}

export function loadSettingsFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new CometError(`Settings file not found: ${path}`, { hint: 'Create it or pass --settings <path>.' });
  }
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CometError(`Invalid JSON in settings file ${path}: ${(err as Error).message}`);
  }
}

/** `--settings` relative to cwd, default `<basePath>/settings.json` (MUP behaviour). */
export function loadSettings(o: { cwd: string; basePath: string; settingsFlag?: string }): {
  settings: unknown;
  settingsPath: string;
} {
  const settingsPath = o.settingsFlag
    ? resolve(o.cwd, expandTilde(o.settingsFlag))
    : join(o.basePath, 'settings.json');
  return { settings: loadSettingsFile(settingsPath), settingsPath };
}

/**
 * Resolves a user-supplied path the way MUP does (`base: 'cwd'` for pem, settings,
 * templatePath; `base: 'config'` for everything else). For cwd-relative paths that
 * do not exist, falls back to the config directory and warns.
 */
export function resolveUserPath(
  p: string,
  o: { cwd: string; basePath: string; base: 'cwd' | 'config'; warn?: (m: string) => void },
): string {
  const expanded = expandTilde(p);
  if (isAbsolute(expanded)) return expanded;
  if (o.base === 'config') return resolve(o.basePath, expanded);
  const fromCwd = resolve(o.cwd, expanded);
  if (existsSync(fromCwd)) return fromCwd;
  const fromBase = resolve(o.basePath, expanded);
  if (fromBase !== fromCwd && existsSync(fromBase)) {
    o.warn?.(`"${p}" not found relative to the current directory; using ${fromBase} (relative to the config file).`);
    return fromBase;
  }
  return fromCwd;
}
