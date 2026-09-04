import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@rulegate/adapter-kit/testing';
import { windsurf } from '../src/index.js';

describe('windsurf read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('windsurf', windsurf);
  });

  it('loses no user content', async () => {
    // The assertion that matters on a first run: `init` must not drop a line of
    // somebody's existing config on the way into .rulegate/.
    await expectContentCovered('windsurf', windsurf, [
      '.windsurf/rules/style.md',
      '.windsurf/rules/tests.md',
    ]);
  });
});
