import { describe, expect, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { aider } from '../src/index.js';

describe('aider read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('aider', aider);
  });

  it('loses no user content', async () => {
    // The assertion that matters on a first run: `init` must not drop a line of
    // somebody's existing config on the way into .driftgate/.
    await expectContentCovered('aider', aider, ['CONVENTIONS.md']);
  });
});

describe('aider read() — never imports the user’s config (T050c)', () => {
  it('imports nothing from .aider.conf.yml, credentials included', async () => {
    const { aider } = await import('../src/index.js');
    const { importContextFor } = await import('@driftgate/adapter-kit/testing');

    const result = await aider.read(importContextFor('aider-import/input'));
    const rules = result.rules ?? [];
    expect(rules.length).toBeGreaterThan(0);

    // The fixture's config is present and carries a distinctive setting, so this runs where
    // the hazard actually is. A fixture holding only CONVENTIONS.md would pass against an
    // adapter that could not have failed — the inert-guard shape recorded two dozen times.
    //
    // The setting is deliberately NOT a credential: `secrets.test.ts` scans every file under
    // `fixtures/`, so a realistic-looking key here turns that suite red. The hazard being
    // guarded is "config content reaches canonical", which needs no real secret to express —
    // and a guard that has to smuggle one past another guard is the wrong guard.
    const everything = rules
      .map((r) => [r.body, r.frontmatter.description ?? '', ...r.frontmatter.globs].join('\n'))
      .join('\n');
    expect(everything).not.toContain('auto-commits');
    expect(everything).not.toContain('read: CONVENTIONS.md');

    // And every rule must have come from CONVENTIONS.md, not from the config.
    for (const rule of rules) expect(rule.source.file).toBe('CONVENTIONS.md');
  });
});
