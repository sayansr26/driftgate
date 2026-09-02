import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createKitProgram } from './program.js';

/**
 * The T011 freeze, enforced.
 *
 * `@driftgate/adapter-kit` is the contract external contributors write against, so a
 * change to this list breaks them. Adding a name is non-breaking and needs only this
 * literal updated with the addition; **removing or renaming one is breaking** and needs
 * an `ADAPTER_API_VERSION` bump — see `docs/adapter-api-v1.md`.
 *
 * Why the compiler API rather than a runtime `Object.keys()` or a committed `.d.ts`:
 * types are erased at runtime, so `Object.keys` would freeze the values and leave
 * `Adapter`, `Artifact` and `AdapterContext` — the actual contract — unguarded; and a
 * `.d.ts` golden needs a build, so it could only run in the DRIFTGATE_TEST_DIST lane and
 * would be silent during ordinary development. This reads source, catches additions and
 * removals of both kinds, and runs on a clean clone.
 *
 * It does not catch a *shape* change to an existing export — a widened return type, a new
 * required field. That is `contract-shape.test.ts`, and it is why the two exist.
 */
const FROZEN_V1 = [
  'ADAPTER_API_VERSION (value)',
  'ALL_TOOLS (value)',
  'Adapter (type)',
  'AdapterContext (type)',
  'AdapterDocs (type)',
  'Artifact (type)',
  'ArtifactDraft (type)',
  'ArtifactKind (type)',
  'Canonical (type)',
  'DEFAULT_RULE_ORDER (value)',
  'DEFAULT_SECTION_OPTIONS (value)',
  'DetectResult (type)',
  'DirEntry (type)',
  'DocNote (type)',
  // Added 2026-09-02 (T025). Non-breaking per docs/adapter-api-v1.md: an addition costs
  // one line here and no ADAPTER_API_VERSION bump. See `AdapterDocs.resolution`.
  'FileResolution (type)',
  'DriftgateError (value)',
  'DriftgateErrorCode (type)',
  'DriftgateErrorInit (type)',
  'DriftgateManifest (type)',
  'HASH_MARKER (value)',
  // Added 2026-09-02 (T017), the import surface. Non-breaking per docs/adapter-api-v1.md:
  // additions cost a line here and no ADAPTER_API_VERSION bump.
  'ImportConcatenatedOptions (type)',
  'ImportedRuleInit (type)',
  'HTML_MARKER (value)',
  'JsonValue (type)',
  'MARKER_TEXT (value)',
  'ManifestOptions (type)',
  'NOT_DETECTED (value)',
  'PrecedenceEntry (type)',
  'ReadOnlyFileSystem (type)',
  'RuleDocument (type)',
  'RuleFrontmatter (type)',
  'RuleId (type)',
  'SectionOptions (type)',
  'SourceLink (type)',
  'SourceRef (type)',
  'ToolConfig (type)',
  'ToolId (type)',
  'ToolSelector (type)',
  'VerifiedAgainst (type)',
  'appliesRepoWide (value)',
  'basenamePosix (value)',
  'claimRuleId (value)',
  'compareCodepoint (value)',
  'detected (value)',
  'dirnamePosix (value)',
  'finalizeArtifact (value)',
  'importConcatenated (value)',
  'importRuleId (value)',
  'importedRule (value)',
  'isCanonicalSource (value)',
  'isDriftgateError (value)',
  'joinPosix (value)',
  'matchesGlob (value)',
  'renderConcatenated (value)',
  'renderRuleSection (value)',
  'ruleHeading (value)',
  'selects (value)',
  'slugForId (value)',
  'sortRules (value)',
  'stripMarker (value)',
  'toPosix (value)',
  'withHashMarker (value)',
  'withHtmlMarker (value)',
];

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function publicSurface(entryFile: string): string[] {
  const program = createKitProgram([entryFile]);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFile);
  if (source === undefined) throw new Error(`could not load ${entryFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${entryFile} is not a module`);

  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => {
      // Re-exports arrive as aliases; the alias itself carries no Value/Type flags, so
      // classification has to follow it to the declaration in core.
      const resolved =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
      // A class is both. Value wins, deterministically, so the label never depends on
      // flag iteration order.
      const kind = (resolved.flags & ts.SymbolFlags.Value) !== 0 ? 'value' : 'type';
      return `${symbol.getName()} (${kind})`;
    })
    .sort();
}

describe('the frozen adapter API (T011)', () => {
  it('exports exactly the frozen v1 surface', () => {
    const actual = publicSurface(entry);
    const added = actual.filter((name) => !FROZEN_V1.includes(name));
    const removed = FROZEN_V1.filter((name) => !actual.includes(name));
    expect(
      { added, removed },
      'the frozen adapter API changed — see docs/adapter-api-v1.md; additions need only this list updated, removals need an ADAPTER_API_VERSION bump',
    ).toEqual({ added: [], removed: [] });
  });

  it('never exposes the host pipeline, state, parser, or a writable filesystem', () => {
    // These are not omissions to be corrected later. An adapter that can write, parse a
    // repository, or run the pipeline can make `check` and `sync` disagree, which is the
    // one thing the architecture exists to prevent.
    const forbidden = [
      'computePlan',
      'applyPlan',
      'verifyPlan',
      'parse',
      'parseManifest',
      'parseRuleFile',
      'serializeCanonical',
      'buildState',
      'compareToDisk',
      'hashContents',
      'NodeFileSystem',
      'MemoryFileSystem',
      'WritableFileSystem',
      'findRepoRoot',
      'resolveRepoRoot',
      // T043/T057 stubs: `Canonical` carries these fields, but naming their element types
      // would let an adapter declare against a shape that is not frozen yet.
      'McpServer',
      'Skill',
    ];
    const names = publicSurface(entry).map((entryName) => entryName.split(' ')[0]);
    expect(forbidden.filter((name) => names.includes(name))).toEqual([]);
  });
});
