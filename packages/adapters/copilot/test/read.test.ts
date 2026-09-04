import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@rulegate/adapter-kit/testing';
import { copilot } from '../src/index.js';

describe('copilot read() (T017)', () => {
  it('imports both mechanisms into the expected canonical rules', async () => {
    await expectImportMatch('copilot', copilot);
  });

  it('loses no user content', async () => {
    await expectContentCovered('copilot', copilot, [
      '.github/copilot-instructions.md',
      '.github/instructions/30-frontend.instructions.md',
    ]);
  });
});
