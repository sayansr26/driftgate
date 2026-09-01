import type { ToolId } from './ids.js';

/**
 * Which adapters a piece of canonical content targets.
 *
 * Three forms and no more (RFC-0001 §7): omitted means every enabled tool, a list
 * means include, `{ exclude: [...] }` means everything but those. Modelled as a
 * discriminated union rather than two optional arrays so that "include and exclude
 * both set" is unrepresentable instead of merely discouraged.
 */
export type ToolSelector =
  | { readonly kind: 'all' }
  | { readonly kind: 'include'; readonly tools: readonly ToolId[] }
  | { readonly kind: 'exclude'; readonly tools: readonly ToolId[] };

export const ALL_TOOLS: ToolSelector = { kind: 'all' };

export function selects(selector: ToolSelector, tool: ToolId): boolean {
  switch (selector.kind) {
    case 'all':
      return true;
    case 'include':
      return selector.tools.includes(tool);
    case 'exclude':
      return !selector.tools.includes(tool);
  }
}
