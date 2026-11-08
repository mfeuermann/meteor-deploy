import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { templatePath } from '../../remote/render.js';
import type { NoConfigCommand } from '../registry.js';

const isMeteorApp = (dir: string) => existsSync(join(dir, '.meteor/release'));

/** Same placement rules as `mup init` (ref. §3.2). */
export function findInitDestination(cwd: string): { dest: string; appPath: string; createFolder: boolean } {
  if (isMeteorApp(cwd)) return { dest: join(cwd, '.deploy'), appPath: '../', createFolder: true };
  const parent = resolve(cwd, '..');
  if (isMeteorApp(parent)) return { dest: cwd, appPath: '../', createFolder: false };
  const children = readdirSync(parent);
  if (children.length === 2) {
    const other = children.find((c) => c !== basename(cwd));
    if (other && isMeteorApp(join(parent, other))) return { dest: cwd, appPath: `../${other}`, createFolder: false };
  }
  return { dest: cwd, appPath: './', createFolder: false };
}

function sampleConfig(appPath: string): string {
  return readFileSync(templatePath('mup/default/mup.js.sample'), 'utf8').replace('<app path>', appPath);
}

function sampleConfigJson(appPath: string): string {
  const module = { exports: {} as unknown };
  new Function('module', 'exports', sampleConfig(appPath))(module, module.exports);
  return JSON.stringify(module.exports, null, 2) + '\n';
}

export const initCommand: NoConfigCommand = {
  command: 'init',
  describe: 'Create mup.js and settings.json for a Meteor app',
  needsConfig: false,
  builder: (y) => y.option('json', { type: 'boolean', describe: 'Write mup.json instead of mup.js' }),
  async run(ctx, argv) {
    const r = ctx.reporter;
    const { dest, appPath, createFolder } = findInitDestination(ctx.cwd);
    if (createFolder && !existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      r.info('Created .deploy folder');
    }

    const settingsDest = join(dest, 'settings.json');
    if (existsSync(settingsDest)) {
      r.info(`Skipping creation of settings.json: settings.json already exists at ${settingsDest}`);
    } else {
      writeFileSync(settingsDest, readFileSync(templatePath('mup/default/settings.json')));
      r.info(`Created settings.json at ${settingsDest}`);
    }

    const existing = ['mup.js', 'mup.json'].map((f) => join(dest, f)).find((p) => existsSync(p));
    if (existing) {
      r.info(`Skipping creation of the config: ${basename(existing)} already exists at ${existing}`);
      return;
    }
    const configDest = join(dest, argv.json ? 'mup.json' : 'mup.js');
    writeFileSync(configDest, argv.json ? sampleConfigJson(appPath) : sampleConfig(appPath));
    r.info(`Created ${basename(configDest)} at ${configDest}`);
    r.info('');
    r.info('Next steps:');
    r.info(`  Open ${basename(configDest)} and edit the config to meet your needs.`);
    if (!argv.json) r.info('  Required changes have been marked with a TODO comment.');
    r.info('  The config format is the same as Meteor Up (https://github.com/zodern/meteor-up).');
    r.info('  Then run: comet-deploy setup');
  },
};
