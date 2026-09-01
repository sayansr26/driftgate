import { compareCodepoint } from './order.js';
import { ensureSingleTrailingNewline } from './eol.js';
import type { JsonValue } from '../model/ids.js';

/**
 * The only JSON writer in the codebase.
 *
 * `JSON.stringify` emits keys in insertion order, which is deterministic in V8 but
 * says nothing about how the object was *built* — and objects assembled from a
 * filesystem walk inherit that walk's order. Sorting keys removes the question.
 */
export function stableJsonStringify(value: JsonValue): string {
  return ensureSingleTrailingNewline(JSON.stringify(sortDeep(value), null, 2));
}

function sortDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodepoint)) {
    out[key] = sortDeep(value[key]!);
  }
  return out;
}
