/**
 * Plain-text tables for the `status` and `history` commands.
 */

/**
 * `header` and `rows` as lines with every column padded to its widest cell, two spaces between
 * columns and no trailing spaces.
 */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
