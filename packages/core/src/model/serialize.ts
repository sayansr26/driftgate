import { stringify as stringifyYaml } from 'yaml';
import { compareCodepoint } from '../render/order.js';
import { ensureSingleTrailingNewline } from '../render/eol.js';
import { DEFAULT_MANIFEST_OPTIONS } from './canonical.js';
import { DEFAULT_RULE_ORDER } from './rule.js';
import { MANIFEST_PATH, ruleIdToPath } from './paths.js';
import type { Canonical } from './canonical.js';
import type { RuleDocument } from './rule.js';
import type { JsonValue } from './ids.js';

/**
 * Canonical model -> the on-disk `.driftgate/` representation, as path -> contents.
 *
 * Used by the round-trip test, and by `init` (T019) to write canonical after import.
 * Defaults are omitted rather than written out: a hand-authored `.driftgate/` should
 * look like something a person would write, and the parser restores defaults anyway,
 * so the model still round-trips.
 */
export function serializeCanonical(canonical: Canonical): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  out.set(MANIFEST_PATH, serializeManifest(canonical));
  for (const rule of canonical.rules) {
    out.set(rule.path === '' ? ruleIdToPath(rule.id) : rule.path, serializeRule(rule));
  }
  return new Map([...out].sort(([a], [b]) => compareCodepoint(a, b)));
}

function serializeManifest(canonical: Canonical): string {
  const { manifest } = canonical;
  const doc: Record<string, JsonValue> = { schemaVersion: manifest.schemaVersion };

  doc['tools'] = manifest.tools.map((tool) => {
    const hasOptions = Object.keys(tool.options).length > 0;
    if (tool.enabled && !hasOptions) return tool.id;
    const entry: Record<string, JsonValue> = { id: tool.id };
    if (!tool.enabled) entry['enabled'] = false;
    if (hasOptions) entry['options'] = { ...tool.options };
    return entry;
  });

  const options: Record<string, JsonValue> = {};
  if (manifest.options.marker !== DEFAULT_MANIFEST_OPTIONS.marker) {
    options['marker'] = manifest.options.marker;
  }
  if (manifest.options.backup !== DEFAULT_MANIFEST_OPTIONS.backup) {
    options['backup'] = manifest.options.backup;
  }
  if (Object.keys(options).length > 0) doc['options'] = options;

  if (manifest.canonicalSources.length > 0) {
    doc['canonicalSources'] = [...manifest.canonicalSources];
  }

  return ensureSingleTrailingNewline(stringifyYaml(doc, { lineWidth: 0 }));
}

function serializeRule(rule: RuleDocument): string {
  const fm = rule.frontmatter;
  const doc: Record<string, JsonValue> = {};

  if (fm.description !== undefined) doc['description'] = fm.description;
  if (fm.globs.length > 0) doc['globs'] = [...fm.globs];
  if (fm.tools.kind === 'include') doc['tools'] = [...fm.tools.tools];
  else if (fm.tools.kind === 'exclude') doc['tools'] = { exclude: [...fm.tools.tools] };
  if (fm.order !== DEFAULT_RULE_ORDER) doc['order'] = fm.order;

  // Unknown keys are re-emitted verbatim so that a round trip through Driftgate never
  // costs a user content it did not understand.
  for (const key of Object.keys(fm.unknown).sort(compareCodepoint)) {
    doc[key] = fm.unknown[key] as JsonValue;
  }

  const body = ensureSingleTrailingNewline(rule.body);
  if (Object.keys(doc).length === 0) return body;

  const yaml = ensureSingleTrailingNewline(stringifyYaml(doc, { lineWidth: 0 }));
  return `---\n${yaml}---\n\n${body}`;
}
