/**
 * `init`: writes a starter `mup.js` (or `mup.json`) and `settings.json` from MUP 1.5.11's
 * sample files, in the same place `mup init` would. Existing files are never overwritten.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { templatePath } from '../../remote/render.js';
import type { NoConfigCommand } from '../registry.js';

/** A directory is a Meteor app when it has `.meteor/release` (MUP's test). */
const isMeteorApp = (dir: string) => existsSync(join(dir, '.meteor/release'));

/**
 * Where `init` writes its files, with the same rules as `mup init`:
 * - in a Meteor app: a new `.deploy/` folder inside it, with `app.path` `../`;
 * - in a folder whose parent is the Meteor app: the folder itself, `app.path` `../`;
 * - in a folder next to the app, when the parent holds exactly these two entries: the folder
 *   itself, `app.path` `../<app folder>`;
 * - anywhere else: the folder itself, `app.path` `./`.
 *
 * `createFolder` tells the caller to create `dest` first.
 */
export function findInitDestination(cwd: string): { dest: string; appPath: string; createFolder: boolean } {
  if (isMeteorApp(cwd)) return { dest: join(cwd, '.deploy'), appPath: '../', createFolder: true };
  const parent = resolve(cwd, '..');
  if (isMeteorApp(parent)) return { dest: cwd, appPath: '../', createFolder: false };
  const children = readdirSync(parent);
  // Like MUP, every entry counts, hidden files included.
  if (children.length === 2) {
    const other = children.find((c) => c !== basename(cwd));
    if (other && isMeteorApp(join(parent, other))) return { dest: cwd, appPath: `../${other}`, createFolder: false };
  }
  return { dest: cwd, appPath: './', createFolder: false };
}

/** MUP's sample mup.js with its `<app path>` placeholder filled in, as `mup init` writes it. */
function sampleConfig(appPath: string): string {
  return readFileSync(templatePath('mup/default/mup.js.sample'), 'utf8').replace('<app path>', appPath);
}

/**
 * The sample as JSON for `init --json`. The sample is a CommonJS module, so it is evaluated
 * to get the object (it is a template shipped with comet-deploy, not user input); its
 * comments and TODO markers do not survive.
 */
function sampleConfigJson(appPath: string): string {
  const module = { exports: {} as unknown };
  new Function('module', 'exports', sampleConfig(appPath))(module, module.exports);
  return JSON.stringify(module.exports, null, 2) + '\n';
}

/** `init [--json]`. Needs no config, because it creates one. */
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

    // Either file blocks a new config: comet-deploy loads mup.js and ignores mup.json when
    // both exist, so a second config file next to the first would only mislead.
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
    // JSON has no comments, so mup.json has no TODO markers.
    if (!argv.json) r.info('  Required changes have been marked with a TODO comment.');
    r.info('  The config format is the same as Meteor Up (https://github.com/zodern/meteor-up).');
    r.info('  Then run: comet-deploy setup');
  },
};
