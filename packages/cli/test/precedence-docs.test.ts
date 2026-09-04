import { describe, expect, it } from 'vitest';
import { expectDocsValid } from '@driftgate/adapter-kit/testing';
import { ADAPTERS } from '../src/registry.js';

/**
 * T025: every claim about what a tool reads carries a source URL and the version it was
 * verified against, so a reviewer can check it and a stale entry is visible rather than
 * silently wrong.
 *
 * Driven off `ADAPTERS` rather than a hardcoded list. `registry.test.ts` already pins
 * `ADAPTERS` to the directory listing under `packages/adapters/`, so a sixth adapter is
 * covered here the day it is registered — a guard that quietly narrows its own scope while
 * staying green is worse than no guard.
 */

/**
 * Which write fixtures hold each adapter's goldens.
 *
 * Convention first — `fixtures/<tool>/` — with an entry here only for an adapter whose
 * output does not all live there. Cursor is the one: `.cursorrules` is opt-in
 * (`options.legacy`), so its goldens are split across two fixture repos. A hardcoded
 * roster used to live here and had to be edited by hand for every adapter, which a
 * scaffolded one (T028) would have failed on the day it landed.
 */
const EXTRA_FIXTURES: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['claude-code-mcp'],
  codex: ['codex-mcp'],
  copilot: ['copilot-mcp'],
  cursor: ['cursor-legacy', 'cursor-mcp'],
  'roo-code': ['roo-code-mcp'],
};

const writeFixturesFor = (tool: string): readonly string[] => [
  tool,
  ...(EXTRA_FIXTURES[tool] ?? []),
];

describe('encoded precedence rules', () => {
  it('names no fixture override for an adapter that is not registered', () => {
    // The overrides are the only hand-maintained part left, and a stale one is invisible:
    // it would point at goldens nothing renders any more.
    const names = new Set(ADAPTERS.map((a) => a.name));
    expect(Object.keys(EXTRA_FIXTURES).filter((tool) => !names.has(tool))).toEqual([]);
  });

  for (const adapter of ADAPTERS) {
    it(`are valid for ${adapter.name}`, async () => {
      await expectDocsValid(adapter, { writeFixtures: writeFixturesFor(adapter.name) });
    });
  }

  it('never lets two adapters claim to manage the same path', () => {
    const owners = new Map<string, string[]>();
    for (const adapter of ADAPTERS) {
      for (const file of adapter.docs.files) {
        if (!file.managed) continue;
        owners.set(file.pattern, [...(owners.get(file.pattern) ?? []), adapter.name]);
      }
    }
    // `E_ARTIFACT_PATH_CONFLICT` restated at the docs layer. `computePlan` catches this at
    // runtime; catching it in the data means it never ships. Note this is about *managed*
    // claims only — `AGENTS.md` and `CLAUDE.md` are legitimately listed as unmanaged
    // context by copilot while another adapter generates them, which is T078's whole point.
    const contested = [...owners.entries()].filter(([, list]) => list.length > 1);
    expect(contested).toEqual([]);
  });
});
