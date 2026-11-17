import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderBanner } from '../../../src/output/banner.js';

describe('renderBanner', () => {
  it('shows COMET, the version, the author and the repository', () => {
    const lines = renderBanner({ version: '1.2.3', color: false, columns: 80 }).split('\n');
    expect(lines[0]).toMatch(/^ ██████╗ ██████╗ ███╗ {3}███╗███████╗████████╗ {3}\. {4}\*$/);
    expect(lines[1]).toMatch(/\(O\)$/);
    expect(lines[3]).toMatch(/d e p l o y {2}v1\.2\.3$/);
    expect(lines[5]).toMatch(/by Marek Feuermann$/);
    // The right column starts two columns after the 45 columns of COMET, in every line.
    expect([lines[1]!.indexOf('. .:::'), lines[3]!.indexOf('d e p l o y'), lines[5]!.indexOf('by Marek')]).toEqual([47, 47, 47]);
    expect(lines[7]).toBe(' github.com/mfeuermann/meteor-deploy');
  });

  it('fits a terminal of 80 columns, without trailing spaces, and ends with a blank line', () => {
    const text = renderBanner({ version: '10.20.30-beta.1', color: false, columns: 80 });
    for (const line of text.split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(80);
      expect(line).toBe(line.trimEnd());
    }
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('is one line in a terminal narrower than the banner', () => {
    expect(renderBanner({ version: '1.2.3', color: false, columns: 60 })).toBe('comet-deploy v1.2.3 · by Marek Feuermann\n\n');
  });

  it('is the full banner when the terminal width is unknown (0 columns or none)', () => {
    for (const columns of [0, undefined]) {
      expect(renderBanner({ version: '1.2.3', color: false, columns }).split('\n')[7]).toBe(' github.com/mfeuermann/meteor-deploy');
    }
  });

  it('is colored only when asked', () => {
    expect(renderBanner({ version: '1.2.3', color: true, columns: 80 })).toContain('\x1b[');
    expect(renderBanner({ version: '1.2.3', color: false, columns: 80 })).not.toContain('\x1b[');
    expect(renderBanner({ version: '1.2.3', color: true, columns: 60 })).toContain('\x1b[');
  });

  it('README.md shows the same banner, without the version', () => {
    const art = renderBanner({ version: 'X', color: false, columns: 80 })
      .split('\n')
      .slice(0, 6)
      .map((line) => line.replace('  vX', ''));
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(['```text', ...art, '```'].join('\n'));
  });
});
