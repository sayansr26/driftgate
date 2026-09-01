import { DriftgateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  type Canonical,
  type DriftgateManifest,
} from '../model/canonical.js';
import { AGENTS_MD, MANIFEST_PATH, RULES_DIR, RULES_GLOB, deriveRuleId } from '../model/paths.js';
import { compareCodepoint } from '../render/order.js';
import { parseManifest } from './manifest.js';
import { parseRuleFile } from './rules.js';
import { suggest } from './suggest.js';
import type { RuleDocument } from '../model/rule.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export type CanonicalMode = 'driftgate-dir' | 'rules-only' | 'bare-agents-md';

export interface ParseInput {
  readonly fs: ReadOnlyFileSystem;
  /** Adapter ids registered in this process, used to seed a synthetic manifest. */
  readonly knownTools?: readonly string[];
}

export interface ParseResult {
  readonly canonical: Canonical;
  readonly errors: readonly DriftgateError[];
  readonly warnings: readonly DriftgateError[];
  readonly mode: CanonicalMode | 'none';
  /** Every file read, repo-relative POSIX, sorted. Feeds `doctor` and state. */
  readonly sourceFiles: readonly string[];
}

/**
 * Read `.driftgate/` (or a bare AGENTS.md) into the canonical model.
 *
 * This never throws for anything a user could have written. It accumulates, so three
 * broken rule files produce three messages in one run rather than a game of
 * whack-a-mole. `sync` refuses to proceed when `errors` is non-empty.
 */
export async function parse(input: ParseInput): Promise<ParseResult> {
  const { fs } = input;
  const errors: DriftgateError[] = [];
  const warnings: DriftgateError[] = [];
  const sourceFiles: string[] = [];

  const manifestRaw = await fs.tryReadFile(MANIFEST_PATH);
  const ruleFiles = (await fs.glob(RULES_GLOB)).filter((p) => p.startsWith(`${RULES_DIR}/`));

  let mode: CanonicalMode | 'none';
  let manifest: DriftgateManifest;

  if (manifestRaw !== undefined) {
    mode = 'driftgate-dir';
    sourceFiles.push(MANIFEST_PATH);
    const parsed = parseManifest(manifestRaw);
    manifest = parsed.manifest;
    errors.push(...parsed.errors);
    errors.push(...checkKnownTools(manifest, input.knownTools));
  } else if (ruleFiles.length > 0) {
    mode = 'rules-only';
    manifest = syntheticManifest(RULES_DIR, input.knownTools ?? [], []);
    warnings.push(
      new DriftgateError({
        code: 'E_MANIFEST_INVALID',
        message: `no ${MANIFEST_PATH}; assuming every detected tool is enabled`,
        source: { file: RULES_DIR },
        hint: `run: driftgate init  (or create ${MANIFEST_PATH})`,
      }),
    );
  } else if (await fs.exists(AGENTS_MD)) {
    mode = 'bare-agents-md';
    // AGENTS.md is canonical input here, so it is registered as a protected source.
    // Without this the Codex adapter (T014) would happily overwrite the very file it
    // was generated from.
    manifest = syntheticManifest(AGENTS_MD, input.knownTools ?? [], [AGENTS_MD]);
  } else {
    return {
      canonical: emptyResultCanonical(),
      errors: [
        new DriftgateError({
          code: 'E_NO_CANONICAL_SOURCE',
          message: 'no canonical source found (.driftgate/ or AGENTS.md)',
          source: { file: '.' },
          hint: 'run: driftgate init',
        }),
      ],
      warnings,
      mode: 'none',
      sourceFiles: [],
    };
  }

  const rules: RuleDocument[] = [];

  if (mode === 'bare-agents-md') {
    const raw = await fs.readFile(AGENTS_MD);
    sourceFiles.push(AGENTS_MD);
    const parsed = parseRuleFile(AGENTS_MD, raw);
    errors.push(...parsed.errors);
    if (parsed.rule) rules.push({ ...parsed.rule, id: 'agents' });
  } else {
    for (const path of ruleFiles) {
      const raw = await fs.readFile(path);
      sourceFiles.push(path);
      const parsed = parseRuleFile(path, raw);
      errors.push(...parsed.errors);
      if (parsed.rule) rules.push(parsed.rule);
    }
    errors.push(...detectIdConflicts(ruleFiles));
  }

  sourceFiles.sort(compareCodepoint);

  return {
    canonical: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      manifest,
      rules,
      mcpServers: [],
      skills: [],
    },
    errors,
    warnings,
    mode,
    sourceFiles,
  };
}

/**
 * A tool id nobody claims is almost always a typo, and an unvalidated one is a config
 * line that silently does nothing — the user sees a tool "enabled" and no output for
 * it. Only checked when the caller says which adapters are registered; parsing with no
 * registry (tests, `doctor` on an unknown repo) stays permissive.
 */
function checkKnownTools(
  manifest: DriftgateManifest,
  knownTools: readonly string[] | undefined,
): DriftgateError[] {
  if (knownTools === undefined || knownTools.length === 0) return [];
  const out: DriftgateError[] = [];
  for (const tool of manifest.tools) {
    if (knownTools.includes(tool.id)) continue;
    const guess = suggest(tool.id, knownTools);
    out.push(
      new DriftgateError({
        code: 'E_UNKNOWN_TOOL',
        message: `no adapter named \`${tool.id}\``,
        source: tool.source,
        hint:
          guess === undefined
            ? `known adapters: ${[...knownTools].sort().join(', ')}`
            : `did you mean \`${guess}\`?`,
      }),
    );
  }
  return out;
}

/**
 * Two files can normalize to one id — `a/b.md` and `a\b.md` on Windows, or NFC and
 * NFD spellings of the same accented name. Silently keeping the last one read would
 * make output depend on filesystem order, so this is an error.
 */
function detectIdConflicts(paths: readonly string[]): DriftgateError[] {
  const byId = new Map<string, string[]>();
  for (const path of paths) {
    const id = deriveRuleId(path);
    byId.set(id, [...(byId.get(id) ?? []), path]);
  }
  const out: DriftgateError[] = [];
  for (const [id, files] of byId) {
    if (files.length < 2) continue;
    out.push(
      new DriftgateError({
        code: 'E_RULE_ID_CONFLICT',
        message: `rule id \`${id}\` is claimed by ${files.join(' and ')}`,
        source: { file: files[0]! },
        hint: 'rename one of the files so each rule has a unique id',
      }),
    );
  }
  return out;
}

function syntheticManifest(
  file: string,
  knownTools: readonly string[],
  canonicalSources: readonly string[],
): DriftgateManifest {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: knownTools.map((id) => ({ id, enabled: true, options: {}, source: { file } })),
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources,
    source: { file },
  };
}

function emptyResultCanonical(): Canonical {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    manifest: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      tools: [],
      options: DEFAULT_MANIFEST_OPTIONS,
      canonicalSources: [],
      source: { file: '.' },
    },
    rules: [],
    mcpServers: [],
    skills: [],
  };
}

export { parseManifest } from './manifest.js';
export { parseRuleFile } from './rules.js';
export { splitFrontmatter } from './frontmatter.js';
