import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { rooCode } from '../src/index.js';

describe('roo-code read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('roo-code', rooCode);
  });

  it('loses no user content', async () => {
    await expectContentCovered('roo-code', rooCode, ['.roo/rules/001-10-style.md']);
  });
});
