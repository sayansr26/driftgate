import type { JsonValue, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

/** Stub for v1 (T057). Present now so later phases extend rather than rewrite. */
export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Markdown body, normalized exactly like `RuleDocument.body`. */
  readonly body: string;
  readonly path: string;
  readonly tools: ToolSelector;
  /** Assets shipped alongside the skill, repo-relative POSIX. */
  readonly assets: readonly string[];
  readonly unknown: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}
