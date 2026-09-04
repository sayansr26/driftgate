import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computePlan, MemoryFileSystem } from '@rulegate/core';
import { ADAPTERS, ADAPTER_NAMES } from '../src/registry.js';

const rfcPath = fileURLToPath(
  new URL('../../../docs/rfc-0001-canonical-format.md', import.meta.url),
);

/**
 * RFC-0001's worked example is parsed by `packages/core/test/rfc.test.ts`, which proves
 * the *input* is authorable. It never proved the *output* was predictable, and for the
 * whole of M0 the RFC named files the renderer does not produce — `.cursor/rules/style.mdc`
 * for a rule at `rules/10-style.md`. These assertions live in the CLI package because
 * core may not import adapters, and rendering is what makes the claim checkable (T076).
 */

/** The example's canonical source, transcribed from §14. */
const EXAMPLE = new Map([
  ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools:\n  - claude-code\n  - cursor\n'],
  [
    '.rulegate/rules/10-style.md',
    '---\ndescription: Style\norder: 10\n---\n\nUse tabs. Never `any`.\n',
  ],
  [
    '.rulegate/rules/20-testing.md',
    '---\ndescription: Testing\norder: 20\n---\n\nVitest. Colocate tests beside the code they cover.\n',
  ],
  [
    '.rulegate/rules/30-frontend.md',
    "---\ndescription: Frontend\nglobs:\n  - 'src/components/**/*.tsx'\norder: 30\n---\n\nPrefer server components.\n",
  ],
]);

/** Every `**\`path\`**` heading after "rulegate sync produces:" in §14. */
async function claimedArtifactPaths(): Promise<string[]> {
  const rfc = await readFile(rfcPath, 'utf8');
  // §14's own sample output contains `## Style` and friends inside fenced blocks, so a
  // naive section split ends at the first one and silently reads almost nothing. Blank
  // the fences first, keeping line structure intact.
  const defenced = rfc.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ''));
  const produced = defenced.split('`rulegate sync` produces:')[1];
  expect(produced, '§14 must still say what sync produces').toBeDefined();
  const section = produced!.split(/^## /m)[0]!;
  return [...section.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1]!);
}

describe('RFC-0001 predicts its own output', () => {
  it('names artifact paths the renderer actually produces', async () => {
    const claimed = await claimedArtifactPaths();
    // Not `> 0`: the fence bug above made this read exactly one path and pass.
    expect(claimed).toContain('CLAUDE.md');
    expect(claimed.length).toBeGreaterThanOrEqual(3);

    const plan = await computePlan({
      repoRoot: '/example',
      fs: new MemoryFileSystem(new Map(EXAMPLE)),
      adapters: ADAPTERS,
    });

    expect(plan.errors).toEqual([]);
    const produced = new Set(plan.artifacts.map((a) => a.path));
    // §14 shows a representative subset, not every artifact, so this is containment
    // rather than equality — but every path it does name must be real.
    expect(claimed.filter((p) => !produced.has(p))).toEqual([]);
  });

  it('names every shipped adapter id', async () => {
    // A reader could previously only learn the true set by triggering E_UNKNOWN_TOOL.
    // Coupling the document to the registry is what stops §4.1 rotting when an adapter
    // lands.
    const rfc = await readFile(rfcPath, 'utf8');
    const missing = ADAPTER_NAMES.filter((id) => !rfc.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it('declares no tool id that has no adapter', async () => {
    // §4's example manifest listed `copilot` for the whole of M0 — an id that fails
    // E_UNKNOWN_TOOL two lines above the sentence saying it would.
    const rfc = await readFile(rfcPath, 'utf8');
    const manifests = [...rfc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const declared = manifests
      .flatMap((y) => [...y.matchAll(/^\s*-\s*(?:id:\s*)?([a-z][a-z0-9-]*)\s*$/gm)])
      .map((m) => m[1]!)
      .filter((id) => id !== 'exclude');

    const unknown = [...new Set(declared)].filter((id) => !ADAPTER_NAMES.includes(id));
    expect(unknown, 'every tool id in an RFC example must be a shipped adapter').toEqual([]);
  });
});
