/**
 * The release notes of one version: its section of CHANGELOG.md, without the heading, plus the
 * "Full changelog" link from the link definitions at the end of the file. The Release workflow
 * checks with it that a version has notes before it publishes, and makes the GitHub release
 * from them.
 *
 *   node scripts/release-notes.ts 0.6.0 [CHANGELOG.md]   # prints the notes; exit 1 without any
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LINK_DEFINITION = /^\[([^\]]+)\]:\s*(\S+)\s*$/;

export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ') || LINK_DEFINITION.test(line)) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  if (text === '') return undefined;
  const link = lines.map((l) => LINK_DEFINITION.exec(l)).find((m) => m?.[1] === version)?.[2];
  return link ? `${text}\n\n**Full changelog:** ${link}` : text;
}

function main(argv: string[]): number {
  const [version, file = 'CHANGELOG.md'] = argv;
  if (!version) {
    process.stderr.write('Usage: node scripts/release-notes.ts <version> [CHANGELOG.md]\n');
    return 2;
  }
  const notes = releaseNotes(readFileSync(file, 'utf8'), version);
  if (!notes) {
    process.stderr.write(`${file} has no notes for ${version}: add a "## [${version}] - <date>" section.\n`);
    return 1;
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
