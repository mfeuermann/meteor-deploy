/**
 * Template rendering for everything that runs on a server. MUP's own templates
 * (`templates/mup/**`, kept byte-identical) and comet-deploy's scripts (`templates/comet/*`)
 * both go through here, so they are rendered by the same EJS engine as in MUP.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../core/version.js';

const require = createRequire(import.meta.url);
// Same template engine and version as MUP (pinned 2.7.5) so output is byte-identical. MUP
// compares some rendered files byte by byte on the server (e.g. mongo-start-current.sh) and
// recreates the container when they differ. The package is CommonJS without type definitions,
// hence `createRequire` and the minimal type below.
const ejs: { render(template: string, data: Record<string, unknown>, opts: { filename: string }): string } = require('@zodern/ejs');

/** Absolute path of a file in the package's `templates/` directory. */
export function templatePath(rel: string): string {
  return join(PACKAGE_ROOT, 'templates', rel);
}

/**
 * Renders `templates/<rel>` with ejs and returns the text; `vars` are the template's
 * variables. `filename` is set so `<% include x %>` resolves next to the template. Rejects
 * when the file cannot be read or the template throws (e.g. a missing variable).
 */
export async function renderTemplate(rel: string, vars: Record<string, unknown>): Promise<string> {
  const path = templatePath(rel);
  return ejs.render(await readFile(path, 'utf8'), vars, { filename: path });
}
