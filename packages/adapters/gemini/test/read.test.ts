import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@rulegate/adapter-kit/testing';
import { gemini } from '../src/index.js';

describe('gemini read() (T017)', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('gemini', gemini);
  });

  it('loses no user content', async () => {
    await expectContentCovered('gemini', gemini, ['GEMINI.md']);
  });
});
