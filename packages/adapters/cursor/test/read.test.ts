import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { cursor } from '../src/index.js';

describe('cursor read() (T017)', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('cursor', cursor);
  });

  it('loses no user content, including the legacy file', async () => {
    await expectContentCovered('cursor', cursor, [
      '.cursor/rules/10-style.mdc',
      '.cursor/rules/30-frontend.mdc',
      '.cursorrules',
    ]);
  });
});
