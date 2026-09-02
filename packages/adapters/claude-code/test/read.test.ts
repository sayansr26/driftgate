import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { claudeCode } from '../src/index.js';

describe('claude-code read() (T017)', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('claude-code', claudeCode);
  });

  it('loses no user content', async () => {
    await expectContentCovered('claude-code', claudeCode, ['CLAUDE.md']);
  });
});
