import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseNotes } from '../../../scripts/release-notes.js';

const CHANGELOG = `# Changelog

Intro text.

## [0.2.0] - 2026-11-13

### Added

- MongoDB.

## [0.1.0] - 2026-11-12

The first release.

### Added

- Deploys.

## [0.0.9] - 2026-11-01

[0.2.0]: https://github.com/o/r/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/o/r/releases/tag/v0.1.0
`;

describe('releaseNotes', () => {
  it('returns the section of the version without its heading, up to the next version', () => {
    expect(releaseNotes(CHANGELOG, '0.2.0')).toBe(
      '### Added\n\n- MongoDB.\n\n**Full changelog:** https://github.com/o/r/compare/v0.1.0...v0.2.0',
    );
  });

  it('leaves out the link definitions after the last section', () => {
    const notes = releaseNotes(CHANGELOG, '0.1.0');
    expect(notes).toBe(
      'The first release.\n\n### Added\n\n- Deploys.\n\n**Full changelog:** https://github.com/o/r/releases/tag/v0.1.0',
    );
  });

  it('has no notes for a version without a section or with an empty one', () => {
    expect(releaseNotes(CHANGELOG, '0.3.0')).toBeUndefined();
    expect(releaseNotes(CHANGELOG, '0.0.9')).toBeUndefined();
    expect(releaseNotes(CHANGELOG, '0.2')).toBeUndefined();
    expect(releaseNotes(CHANGELOG, '0.2.0-beta.1')).toBeUndefined();
  });

  it('CHANGELOG.md has notes for the version in package.json', () => {
    const root = new URL('../../../', import.meta.url);
    const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };
    const notes = releaseNotes(readFileSync(new URL('CHANGELOG.md', root), 'utf8'), version);
    expect(notes, `CHANGELOG.md needs a "## [${version}]" section`).toBeTruthy();
  });
});
