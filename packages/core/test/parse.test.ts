import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { NodeFileSystem } from '../src/io/node.js';
import { parse } from '../src/parse/index.js';
import { ALL_TOOLS } from '../src/model/selector.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const KNOWN_TOOLS = ['claude-code', 'cursor', 'copilot', 'codex', 'gemini'];

async function parseFixture(name: string) {
  return parse({
    fs: new NodeFileSystem(path.join(fixtures, 'malformed', name)),
    knownTools: KNOWN_TOOLS,
  });
}

describe('valid input', () => {
  it('parses a manifest and rules', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools: [claude-code, cursor]\n'],
        ['.rulegate/rules/10-style.md', '---\ndescription: Style\norder: 10\n---\n\nUse tabs.\n'],
        ['.rulegate/rules/20-tests.md', '---\ndescription: Testing\n---\n\nVitest.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });

    expect(result.errors).toEqual([]);
    expect(result.mode).toBe('rulegate-dir');
    expect(result.canonical.rules).toHaveLength(2);
    expect(result.sourceFiles).toEqual([
      '.rulegate/rulegate.yaml',
      '.rulegate/rules/10-style.md',
      '.rulegate/rules/20-tests.md',
    ]);
  });

  it('parses options.ignore, and rejects a non-string entry by file and line', async () => {
    const ok = await parse({
      fs: new MemoryFileSystem([
        [
          '.rulegate/rulegate.yaml',
          'schemaVersion: 1\ntools: [cursor]\noptions:\n  ignore:\n    - fixtures/**\n',
        ],
        ['.rulegate/rules/a.md', 'Body.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });
    expect(ok.errors).toEqual([]);
    expect(ok.canonical.manifest.options.ignore).toEqual(['fixtures/**']);

    // The default has to stay empty: `ignore` suppresses a warning, and a default that
    // suppressed anything would hide the finding from every repo that never set it.
    const bare = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools: [cursor]\n'],
        ['.rulegate/rules/a.md', 'Body.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });
    expect(bare.canonical.manifest.options.ignore).toEqual([]);

    const bad = await parse({
      fs: new MemoryFileSystem([
        [
          '.rulegate/rulegate.yaml',
          'schemaVersion: 1\ntools: [cursor]\noptions:\n  ignore:\n    - 7\n',
        ],
        ['.rulegate/rules/a.md', 'Body.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]?.message).toContain('options.ignore[0]');
    expect(bad.errors[0]?.source?.file).toBe('.rulegate/rulegate.yaml');
    expect(bad.errors[0]?.source?.line).toBe(5);
  });

  it('accepts a rule with no frontmatter at all', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools: [cursor]\n'],
        ['.rulegate/rules/plain.md', 'Just prose, no frontmatter.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });

    expect(result.errors).toEqual([]);
    const rule = result.canonical.rules[0]!;
    expect(rule.body).toBe('Just prose, no frontmatter.\n');
    expect(rule.frontmatter.globs).toEqual([]);
    expect(rule.frontmatter.tools).toEqual(ALL_TOOLS);
    expect(rule.frontmatter.order).toBe(100);
  });

  it('treats a bare AGENTS.md as canonical and protects it from being overwritten', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([['AGENTS.md', '# House rules\n\nBe careful.\n']]),
      knownTools: KNOWN_TOOLS,
    });

    expect(result.errors).toEqual([]);
    expect(result.mode).toBe('bare-agents-md');
    expect(result.canonical.rules[0]?.id).toBe('agents');
    // Without this, the Codex adapter would generate AGENTS.md from AGENTS.md and
    // destroy the source. PRD §11 rates that failure as trust-fatal.
    expect(result.canonical.manifest.canonicalSources).toEqual(['AGENTS.md']);
    expect(result.canonical.manifest.tools.map((t) => t.id)).toEqual(KNOWN_TOOLS);
  });

  it('warns but proceeds when rules exist without a manifest', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([['.rulegate/rules/a.md', 'Body.\n']]),
      knownTools: KNOWN_TOOLS,
    });

    expect(result.mode).toBe('rules-only');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.hint).toContain('rulegate init');
  });

  it('reports a missing canonical source with a next step', async () => {
    const result = await parse({ fs: new MemoryFileSystem(), knownTools: KNOWN_TOOLS });

    expect(result.mode).toBe('none');
    expect(result.errors[0]?.code).toBe('E_NO_CANONICAL_SOURCE');
    expect(result.errors[0]?.hint).toBe('run: rulegate init');
  });
});

describe('malformed input', () => {
  it('has a fixture directory for every documented case', async () => {
    const dirs = (await readdir(path.join(fixtures, 'malformed'), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([
      'bad-manifest',
      'unknown-tool',
      'unquoted-glob',
      'unterminated-frontmatter',
      'wrong-type',
    ]);
  });

  it.each([
    ['unterminated-frontmatter', 'E_FRONTMATTER_UNTERMINATED', 'add a closing `---`'],
    ['unquoted-glob', 'E_YAML_SYNTAX', "quote glob patterns that start with '*'"],
    ['wrong-type', 'E_FRONTMATTER_INVALID', 'use a whole number'],
    ['unknown-tool', 'E_UNKNOWN_TOOL', 'did you mean `cursor`?'],
    ['bad-manifest', 'E_MANIFEST_INVALID', 'tools: [claude-code, cursor]'],
  ])('%s reports %s with an actionable hint', async (fixture, code, hint) => {
    const result = await parseFixture(fixture);

    expect(result.errors.length).toBeGreaterThan(0);
    const error = result.errors.find((e) => e.code === code);
    expect(
      error,
      `expected a ${code} among ${result.errors.map((e) => e.code).join(', ')}`,
    ).toBeDefined();
    expect(error!.hint ?? '').toContain(hint);
  });

  it('names the file, the line, and the field in every message', async () => {
    for (const fixture of [
      'unterminated-frontmatter',
      'unquoted-glob',
      'wrong-type',
      'unknown-tool',
      'bad-manifest',
    ]) {
      const result = await parseFixture(fixture);
      for (const error of result.errors) {
        const formatted = error.format();
        expect(formatted, fixture).toMatch(/\.(md|yaml):\d+/);
        expect(formatted, fixture).toContain('hint:');
        // A stack trace in user-facing output means the error escaped unhandled.
        expect(formatted, fixture).not.toContain('    at ');
      }
    }
  });

  it('never rejects: a broken repo yields errors, not an exception', async () => {
    for (const fixture of [
      'unterminated-frontmatter',
      'unquoted-glob',
      'wrong-type',
      'unknown-tool',
      'bad-manifest',
    ]) {
      await expect(parseFixture(fixture)).resolves.toBeDefined();
    }
  });

  it('accumulates every error in one run rather than stopping at the first', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools: [cursor]\n'],
        ['.rulegate/rules/a.md', '---\norder: high\n---\n\nA.\n'],
        ['.rulegate/rules/b.md', '---\norder: low\n---\n\nB.\n'],
        ['.rulegate/rules/c.md', '---\ndescription: 5\n---\n\nC.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });

    // Three broken files should produce three messages, not a game of whack-a-mole.
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.source?.file).sort()).toEqual([
      '.rulegate/rules/a.md',
      '.rulegate/rules/b.md',
      '.rulegate/rules/c.md',
    ]);
  });

  it('reports rule ids that collide after NFC normalization', async () => {
    // Exercised in memory: APFS normalizes filenames on lookup and silently merges
    // these two, so the collision is unreproducible on macOS but real on ext4. That
    // platform split is precisely why ids are NFC-normalized.
    const nfc = '.rulegate/rules/café.md';
    const nfd = '.rulegate/rules/café.md';
    const result = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools: [cursor]\n'],
        [nfc, 'Composed.\n'],
        [nfd, 'Decomposed.\n'],
      ]),
      knownTools: KNOWN_TOOLS,
    });

    const conflict = result.errors.find((e) => e.code === 'E_RULE_ID_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.message).toContain('café');
  });

  it('matches the recorded message for the documented fixture', async () => {
    const expected = await readFile(
      path.join(fixtures, 'malformed/unterminated-frontmatter/expected-error.txt'),
      'utf8',
    );
    const result = await parseFixture('unterminated-frontmatter');
    expect(`${result.errors.map((e) => e.format()).join('\n')}\n`).toBe(expected);
  });
});
