import { isMap, isScalar, isSeq, type Node } from 'yaml';
import type { DriftgateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  type DriftgateManifest,
  type ManifestOptions,
  type ToolConfig,
} from '../model/canonical.js';
import { MANIFEST_PATH } from '../model/paths.js';
import { parseYaml } from './yaml.js';
import { Validator } from './validate.js';
import type { JsonValue } from '../model/ids.js';

export interface ParsedManifest {
  readonly manifest: DriftgateManifest;
  readonly errors: readonly DriftgateError[];
}

export function parseManifest(raw: string, file = MANIFEST_PATH): ParsedManifest {
  const parsed = parseYaml(raw, file);
  if (!parsed.ok) return { manifest: fallbackManifest(file), errors: [parsed.error] };

  const v = new Validator(file, parsed.value, 'E_MANIFEST_INVALID');
  const root = parsed.value.doc.contents as Node | null;
  const map = root === null ? undefined : v.asMap(root, 'manifest');

  const schemaVersion = v.integer(
    v.get(map, 'schemaVersion'),
    'schemaVersion',
    CANONICAL_SCHEMA_VERSION,
  );
  const tools = parseTools(v, v.get(map, 'tools'), file);
  const options = parseOptions(v, v.get(map, 'options'));
  const canonicalSources = v.stringArray(v.get(map, 'canonicalSources'), 'canonicalSources');

  return {
    manifest: {
      schemaVersion,
      tools,
      options,
      canonicalSources,
      source: { file },
    },
    errors: v.errors,
  };
}

function parseTools(v: Validator, node: Node | undefined, file: string): ToolConfig[] {
  if (node === undefined) return [];
  if (!isSeq(node)) {
    v.fail(node, 'tools', '`tools` must be a list', 'e.g. tools: [claude-code, cursor]');
    return [];
  }

  const out: ToolConfig[] = [];
  node.items.forEach((item, i) => {
    const el = item as Node;
    const field = `tools[${i}]`;

    // Shorthand: a bare string means enabled with no options.
    if (isScalar(el) && typeof el.value === 'string') {
      out.push({
        id: el.value,
        enabled: true,
        options: {},
        source: v.yaml.posAt(el.range?.[0], field),
      });
      return;
    }

    if (!isMap(el)) {
      v.fail(el, field, `\`${field}\` must be a tool id or a mapping with an \`id\``);
      return;
    }

    const id = v.string(v.get(el, 'id'), `${field}.id`);
    if (id === undefined) {
      v.fail(el, `${field}.id`, `\`${field}\` is missing a tool \`id\``);
      return;
    }

    const enabled = v.boolean(v.get(el, 'enabled'), `${field}.enabled`, true);
    const optionsNode = v.asMap(v.get(el, 'options'), `${field}.options`);
    const options: Record<string, JsonValue> = {};
    for (const key of v.keys(optionsNode)) options[key] = v.plain(v.get(optionsNode, key));

    out.push({ id, enabled, options, source: v.yaml.posAt(el.range?.[0], field) });
  });

  const seen = new Set<string>();
  for (const tool of out) {
    if (seen.has(tool.id)) {
      v.fail(null, 'tools', `tool \`${tool.id}\` is declared more than once`);
    }
    seen.add(tool.id);
  }

  void file;
  return out;
}

function parseOptions(v: Validator, node: Node | undefined): ManifestOptions {
  const map = v.asMap(node, 'options');
  return {
    marker: v.boolean(v.get(map, 'marker'), 'options.marker', DEFAULT_MANIFEST_OPTIONS.marker),
    eol: 'lf',
    backup: v.boolean(v.get(map, 'backup'), 'options.backup', DEFAULT_MANIFEST_OPTIONS.backup),
  };
}

function fallbackManifest(file: string): DriftgateManifest {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source: { file },
  };
}
