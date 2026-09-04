import type { McpServer } from '../model/mcp.js';
import type { ToolId } from '../model/ids.js';
import { selects } from '../model/selector.js';
import { compareCodepoint } from './order.js';

/**
 * The servers one tool's generated config should contain.
 *
 * Shared rather than written per adapter for the reason `slugForId` is shared (T011): the
 * three predicates below are one rule, and two adapters restating it independently is how
 * they come to disagree about the same server. Each of the three is a refusal to write
 * something, so a divergence here means one tool silently receives a server the other was
 * told to skip.
 *
 * - `enabled: false` keeps the definition and generates nothing (RFC-0001 §11.1).
 * - `scope: 'global'` has no lawful write path at all — `escapesRoot` refuses anything
 *   outside the repository and `AdapterContext` has no home directory (§11.3). `doctor`
 *   reports these; adapters never write them.
 * - `tools` is the same selector a rule carries (§7).
 *
 * Sorted by id because a generated file's byte order is a contract (NFR4) and the parser's
 * ordering is not something an adapter should have to rely on.
 *
 * **The sort is invisible to both v0.2 writers, and that is not a reason to drop it.**
 * `stableJsonStringify` sorts every object key deeply, so a JSON target comes out ordered
 * whatever order it was handed — a mutation deleting this line passes every golden. The
 * first target that does not sort for itself is T047's Codex `config.toml`, where insertion
 * order *is* the file order. Its only guard is the unit test in `core/test/mcp.test.ts`,
 * which reverses the input; nothing at the adapter level can see it.
 */
export function selectMcpServers(
  servers: readonly McpServer[],
  tool: ToolId,
): readonly McpServer[] {
  return servers
    .filter((s) => s.enabled && s.scope === 'project' && selects(s.tools, tool))
    .slice()
    .sort((a, b) => compareCodepoint(a.id, b.id));
}
