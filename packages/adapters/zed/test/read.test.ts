import { describe, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@rulegate/adapter-kit/testing';
import { zed } from '../src/index.js';

describe('zed read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('zed', zed);
  });

  it('loses no user content', async () => {
    // The assertion that matters on a first run: `init` must not drop a line of
    // somebody's existing config on the way into .rulegate/.
    await expectContentCovered('zed', zed, ['.rules']);
  });
});
