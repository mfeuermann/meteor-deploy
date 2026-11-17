/**
 * The banner that `deploy`, `meteor deploy` and `setup` print first, in a terminal only: it
 * never reaches a CI log or redirected output (see `buildCli`). In a terminal narrower than
 * the banner it is a single line, so it never wraps into a mess.
 */
import pc from 'picocolors';

const AUTHOR = 'Marek Feuermann';
const REPOSITORY = 'github.com/mfeuermann/meteor-deploy';

/** "COMET" in the ANSI Shadow figlet font, every line 45 columns wide (trailing spaces included). */
const COMET = [
  ' ██████╗ ██████╗ ███╗   ███╗███████╗████████╗',
  '██╔════╝██╔═══██╗████╗ ████║██╔════╝╚══██╔══╝',
  '██║     ██║   ██║██╔████╔██║█████╗     ██║   ',
  '██║     ██║   ██║██║╚██╔╝██║██╔══╝     ██║   ',
  '╚██████╗╚██████╔╝██║ ╚═╝ ██║███████╗   ██║   ',
  ' ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝   ╚═╝   ',
];

/** The banner, followed by a blank line. `columns`: the terminal width; 0 or none is unknown. */
export function renderBanner(opts: { version: string; color: boolean; columns?: number }): string {
  const c = pc.createColors(opts.color);
  const version = `v${opts.version}`;
  // The right column, plain and colored: a comet flying over "deploy", then the author.
  const right: Array<[plain: string, colored: string]> = [
    ['   .    *', `   ${c.dim('.    *')}`],
    ['  . .:::==(O)', `  ${c.dim('. .:::==')}${c.bold(c.yellow('(O)'))}`],
    ['', ''],
    [`  d e p l o y  ${version}`, `  ${c.bold('d e p l o y')}  ${c.dim(version)}`],
    ['', ''],
    [`  by ${AUTHOR}`, `  by ${c.bold(AUTHOR)}`],
  ];
  const width = Math.max(...COMET.map((line, i) => (line + right[i]![0]).trimEnd().length));
  if (opts.columns && opts.columns < width) {
    return `${c.bold('comet-deploy')} ${c.dim(version)} · by ${c.bold(AUTHOR)}\n\n`;
  }
  const lines = COMET.map((line, i) => {
    const [plain, colored] = right[i]!;
    const art = plain === '' ? line.trimEnd() : line;
    return c.cyan(art) + colored;
  });
  return [...lines, '', ` ${c.dim(REPOSITORY)}`, '', ''].join('\n');
}
