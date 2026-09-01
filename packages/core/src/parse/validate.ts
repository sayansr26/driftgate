import { isAlias, isMap, isScalar, isSeq, type Node, type YAMLMap } from 'yaml';
import { DriftgateError, type DriftgateErrorCode } from '../model/errors.js';
import type { JsonValue } from '../model/ids.js';
import type { YamlParse } from './yaml.js';

/**
 * Hand-rolled validators over the YAML AST rather than zod/ajv.
 *
 * A schema library validates plain JS values, which have already lost their source
 * positions — so it can say "order must be an integer" but never "on line 4". Since
 * T004's whole requirement is naming the file, line, and field, the positions have to
 * be threaded through anyway, and at that point the library earns nothing.
 */
export class Validator {
  readonly errors: DriftgateError[] = [];

  constructor(
    readonly file: string,
    readonly yaml: YamlParse,
    readonly code: DriftgateErrorCode = 'E_FRONTMATTER_INVALID',
  ) {}

  /**
   * A bare `*` opens a YAML alias, so `globs: *.ts` parses as an unresolved Alias
   * node with no error at all — the user's first glob silently becomes nothing.
   * Catching it here rather than at the syntax layer covers every spelling
   * (`globs: *.ts`, `globs: [*.ts]`, and the block-sequence form), and turns a
   * guaranteed first-run papercut into a one-line fix.
   */
  private aliasTrap(node: Node | undefined, field: string): boolean {
    if (node === undefined || !isAlias(node)) return false;
    this.errors.push(
      new DriftgateError({
        code: 'E_YAML_SYNTAX',
        message: `\`${field}\` starts with '*', which YAML reads as an alias rather than text`,
        source: this.yaml.posAt(node.range?.[0], field),
        hint: "quote glob patterns that start with '*', e.g. globs: ['*.ts']",
      }),
    );
    return true;
  }

  fail(node: Node | null | undefined, field: string, message: string, hint?: string): void {
    this.errors.push(
      new DriftgateError({
        code: this.code,
        message,
        source: this.yaml.posAt(node?.range?.[0], field),
        ...(hint === undefined ? {} : { hint }),
      }),
    );
  }

  get(map: YAMLMap | undefined, key: string): Node | undefined {
    if (!map) return undefined;
    const found = map.items.find((item) => isScalar(item.key) && item.key.value === key);
    return (found?.value as Node | undefined) ?? undefined;
  }

  keys(map: YAMLMap | undefined): string[] {
    if (!map) return [];
    return map.items
      .map((item) => (isScalar(item.key) ? String(item.key.value) : ''))
      .filter((k) => k !== '');
  }

  asMap(node: Node | undefined, field: string): YAMLMap | undefined {
    if (node === undefined) return undefined;
    if (!isMap(node)) {
      this.fail(node, field, `\`${field}\` must be a mapping, got ${describe(node)}`);
      return undefined;
    }
    return node;
  }

  string(node: Node | undefined, field: string): string | undefined {
    if (node === undefined) return undefined;
    if (this.aliasTrap(node, field)) return undefined;
    if (!isScalar(node) || typeof node.value !== 'string') {
      this.fail(node, field, `\`${field}\` must be a string, got ${describe(node)}`);
      return undefined;
    }
    return node.value;
  }

  boolean(node: Node | undefined, field: string, fallback: boolean): boolean {
    if (node === undefined) return fallback;
    if (!isScalar(node) || typeof node.value !== 'boolean') {
      this.fail(node, field, `\`${field}\` must be true or false, got ${describe(node)}`);
      return fallback;
    }
    return node.value;
  }

  integer(node: Node | undefined, field: string, fallback: number): number {
    if (node === undefined) return fallback;
    if (!isScalar(node) || typeof node.value !== 'number' || !Number.isInteger(node.value)) {
      this.fail(
        node,
        field,
        `\`${field}\` must be an integer, got ${describe(node)}`,
        `use a whole number, e.g. \`${field}: 10\``,
      );
      return fallback;
    }
    return node.value;
  }

  stringArray(node: Node | undefined, field: string): string[] {
    if (node === undefined) return [];
    if (this.aliasTrap(node, field)) return [];
    // A single string is accepted where a list is expected: it is unambiguous, and
    // rejecting `globs: src/**` would be pedantry rather than safety.
    if (isScalar(node) && typeof node.value === 'string') return [node.value];
    if (!isSeq(node)) {
      this.fail(node, field, `\`${field}\` must be a list of strings, got ${describe(node)}`);
      return [];
    }
    const out: string[] = [];
    node.items.forEach((item, i) => {
      const el = item as Node;
      if (this.aliasTrap(el, `${field}[${i}]`)) return;
      if (isScalar(el) && typeof el.value === 'string') out.push(el.value);
      else this.fail(el, `${field}[${i}]`, `\`${field}[${i}]\` must be a string`);
    });
    return out;
  }

  /** Plain JS value for a node we do not interpret — used to preserve unknown keys. */
  plain(node: Node | undefined): JsonValue {
    return (node?.toJSON() ?? null) as JsonValue;
  }
}

function describe(node: Node): string {
  if (isScalar(node)) {
    if (node.value === null) return 'null';
    return typeof node.value === 'string' ? `string "${node.value}"` : typeof node.value;
  }
  if (isSeq(node)) return 'a list';
  if (isMap(node)) return 'a mapping';
  return 'an unsupported value';
}
