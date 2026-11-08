import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../core/version.js';

const require = createRequire(import.meta.url);
// Same template engine and version as MUP (pinned 2.7.5) so output is byte-identical.
const ejs: { render(template: string, data: Record<string, unknown>, opts: { filename: string }): string } = require('@zodern/ejs');

/** Absolute path of a file in the package's `templates/` directory. */
export function templatePath(rel: string): string {
  return join(PACKAGE_ROOT, 'templates', rel);
}

/** Renders a template with ejs; `filename` is set so `<% include x %>` resolves next to it. */
export async function renderTemplate(rel: string, vars: Record<string, unknown>): Promise<string> {
  const path = templatePath(rel);
  return ejs.render(await readFile(path, 'utf8'), vars, { filename: path });
}
