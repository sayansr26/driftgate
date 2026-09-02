import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { codex } from '../src/index.js';

describe('codex read() (T017)', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('codex', codex);
  });

  it('loses no user content', async () => {
    await expectContentCovered('codex', codex, ['AGENTS.md']);
  });
});
