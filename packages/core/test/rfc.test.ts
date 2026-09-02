import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL_FIELDS, NORMATIVE_TOPICS } from '../src/model/fields.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { parse } from '../src/parse/index.js';

const rfcPath = fileURLToPath(
  new URL('../../../docs/rfc-0001-canonical-format.md', import.meta.url),
);

describe('RFC-0001 covers the canonical format', () => {
  it('documents every field in the model', async () => {
    const rfc = await readFile(rfcPath, 'utf8');
    const undocumented = MODEL_FIELDS.filter((field) => !rfc.includes(field));
    expect(undocumented).toEqual([]);
  });

  it('states each normative guarantee explicitly', async () => {
    const rfc = await readFile(rfcPath, 'utf8');
    const missing = NORMATIVE_TOPICS.filter((topic) => !rfc.includes(topic));
    expect(missing).toEqual([]);
  });

  it('records what was deferred, so the minimal scope is a decision and not an omission', async () => {
    const rfc = await readFile(rfcPath, 'utf8');
    expect(rfc).toMatch(/##\s*13\.\s*Explicitly deferred/);
    for (const deferred of ['extends', 'Templating', 'Conditional rules', 'Nested']) {
      expect(rfc).toContain(deferred);
    }
  });

  it('carries a worked example a reader can hand-author from', async () => {
    const rfc = await readFile(rfcPath, 'utf8');
    expect(rfc).toMatch(/##\s*14\.\s*Worked example/);
    expect(rfc).toContain('driftgate.yaml');
    expect(rfc).toContain('CLAUDE.md');
    // The filename comes from the rule id, prefix and all. The RFC said `style.mdc` for
    // a rule at `rules/10-style.md` for the whole of M0, and this assertion pinned the
    // wrong value rather than catching it (T076).
    expect(rfc).toContain('.cursor/rules/10-style.mdc');
    expect(rfc).toContain('.cursor/rules/30-frontend.mdc');
  });

  it('specifies how a rule id becomes a per-file artifact name', async () => {
    // Authoring input was specifiable from this RFC on day 2; predicting output was not.
    const rfc = await readFile(rfcPath, 'utf8');
    expect(rfc).toContain('E_ARTIFACT_PATH_CONFLICT');
    expect(rfc).toContain('frontend-react');
  });

  it('states that the registry, not this document, is authoritative for tool ids', async () => {
    // Core cannot name adapters, so the id list itself is checked against the real
    // registry in packages/cli/test/rfc-output.test.ts. What belongs here is the RFC
    // admitting where the truth lives.
    const rfc = await readFile(rfcPath, 'utf8');
    expect(rfc).toMatch(/###\s*4\.1\s*Tool ids/);
    expect(rfc).toContain('E_UNKNOWN_TOOL');
  });

  /**
   * The strongest available proxy for "a second reader can hand-author a valid
   * .driftgate/ from the RFC alone": the RFC's own worked example is fed to the real
   * parser. If the spec and the implementation ever drift apart, this fails — which is
   * the failure mode a prose-only spec hides for months.
   */
  it('has a worked example that actually parses', async () => {
    const files = new Map([
      ['.driftgate/driftgate.yaml', 'schemaVersion: 1\ntools:\n  - claude-code\n  - cursor\n'],
      [
        '.driftgate/rules/10-style.md',
        '---\ndescription: Style\norder: 10\n---\n\nUse tabs. Never `any`.\n',
      ],
      [
        '.driftgate/rules/20-testing.md',
        '---\ndescription: Testing\norder: 20\n---\n\nVitest. Colocate tests beside the code they cover.\n',
      ],
      [
        '.driftgate/rules/30-frontend.md',
        "---\ndescription: Frontend\nglobs:\n  - 'src/components/**/*.tsx'\norder: 30\n---\n\nPrefer server components.\n",
      ],
    ]);

    const result = await parse({ fs: new MemoryFileSystem(files) });

    expect(result.errors).toEqual([]);
    expect(result.mode).toBe('driftgate-dir');
    expect(result.canonical.manifest.tools.map((t) => t.id)).toEqual(['claude-code', 'cursor']);
    expect(result.canonical.rules.map((r) => r.id)).toEqual([
      '10-style',
      '20-testing',
      '30-frontend',
    ]);
    expect(result.canonical.rules.map((r) => r.frontmatter.order)).toEqual([10, 20, 30]);
    expect(result.canonical.rules.find((r) => r.id === '30-frontend')?.frontmatter.globs).toEqual([
      'src/components/**/*.tsx',
    ]);
  });

  it('rejects the unquoted-glob trap it warns about, with the promised hint', async () => {
    const files = new Map([
      ['.driftgate/driftgate.yaml', 'schemaVersion: 1\ntools: [cursor]\n'],
      ['.driftgate/rules/a.md', '---\nglobs: *.ts\n---\n\nBody.\n'],
    ]);

    const result = await parse({ fs: new MemoryFileSystem(files) });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('E_YAML_SYNTAX');
    expect(result.errors[0]?.hint).toContain("quote glob patterns that start with '*'");
  });
});
