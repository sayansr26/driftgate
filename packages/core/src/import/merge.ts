import { hashContents, loadState } from '../state/state.js';
import { serializeCanonical } from '../model/serialize.js';
import { compareCodepoint } from '../render/order.js';
import { collectImports } from './collect.js';
import type { Adapter } from '../adapter/adapter.js';
import type { RulegateError } from '../model/errors.js';
import type { Canonical } from '../model/canonical.js';
import type { CanonicalFile } from '../pipeline/apply.js';
import type { Plan } from '../pipeline/plan.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { RuleDocument } from '../model/rule.js';
import type { ToolId } from '../model/ids.js';

/**
 * T051 — merge a hand-edit on a generated file back into `.rulegate/`.
 *
 * Hand-editing generated files is a habit users will not break, and today the only way out
 * is to delete your own edit. That is the one outcome worse than doing nothing, so this is
 * the escape hatch T075 has been waiting on.
 *
 * **`state.json` records a hash, not the ancestor text**, and a three-way merge needs the
 * ancestor's *content*. That gives two situations that must not be blurred:
 *
 * - The recorded hash still equals the hash of what canonical renders *now*. Then the
 *   render **is** the ancestor: the file we wrote is reconstructible, the only thing that
 *   moved is the user's edit, and reversing that edit through `adapter.read()` is
 *   well-founded.
 * - The recorded hash does not match. Canonical has moved on too, both sides changed, and
 *   there is no ancestor text anywhere — only a hash proving the common version is gone.
 *   **Refuse and show both sides.** Reconstructing an ancestor by guesswork is precisely
 *   how a silent clobber gets in, and "never silently clobber" is this task's own
 *   requirement.
 */

/** What the merge would do to one canonical rule. */
export interface RuleMerge {
  readonly id: string;
  /** The rule file under `.rulegate/rules/`. */
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** Which generated files the new body was recovered from, sorted. */
  readonly from: readonly string[];
}

/** A hand-edited file the merge declines to act on, and why. */
export interface MergeRefusal {
  readonly path: string;
  readonly reason: 'no-ancestor' | 'conflict' | 'unrecoverable';
  readonly detail: string;
}

export interface MergePlan {
  /** Rules whose body would change, sorted by path. Empty when there is nothing to merge. */
  readonly merges: readonly RuleMerge[];
  /** The `.rulegate/` files to write. Empty exactly when `merges` is. */
  readonly files: readonly CanonicalFile[];
  readonly refusals: readonly MergeRefusal[];
  readonly errors: readonly RulegateError[];
}

export interface MergeInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  readonly canonical: Canonical;
  readonly plan: Plan;
  /** Generated paths whose bytes on disk are no longer the bytes we wrote. */
  readonly handEdited: readonly string[];
}

export async function computeMergePlan(input: MergeInput): Promise<MergePlan> {
  const { repoRoot, fs, adapters, canonical, plan, handEdited } = input;
  const refusals: MergeRefusal[] = [];

  const { state } = await loadState(fs);
  const recorded = new Map(state.artifacts.map((a) => [a.path, a.hash]));
  const rendered = new Map(plan.artifacts.map((a) => [a.path, a.contents]));

  // Which adapter owns each hand-edited path, so only the adapters that actually have an
  // edit to recover are re-read.
  const owner = new Map<string, ToolId>();
  for (const artifact of plan.artifacts) owner.set(artifact.path, artifact.adapter);

  const eligible: string[] = [];
  for (const path of [...handEdited].sort(compareCodepoint)) {
    const render = rendered.get(path);
    const hash = recorded.get(path);
    if (render === undefined || hash === undefined) {
      // Not a planned, recorded artifact: `--force` is the answer for somebody else's
      // file, and there is nothing of ours to merge into.
      refusals.push({
        path,
        reason: 'unrecoverable',
        detail: 'rulegate has no record of writing this file',
      });
      continue;
    }
    if (hashContents(render) !== hash) {
      refusals.push({
        path,
        reason: 'no-ancestor',
        detail:
          'the canonical source changed too, so the version you edited cannot be reconstructed',
      });
      continue;
    }
    eligible.push(path);
  }

  if (eligible.length === 0) return { merges: [], files: [], refusals, errors: [] };

  const tools = new Set(
    eligible.map((p) => owner.get(p)).filter((t): t is ToolId => t !== undefined),
  );
  const collected = await collectImports({
    repoRoot,
    fs,
    adapters: adapters.filter((a) => tools.has(a.name)),
    canonical,
  });

  // Reverse-mapping the edit into canonical *is* `adapter.read()` — the exact inverse of
  // `renderConcatenated` on a file carrying our marker, already proved by the round-trip
  // fixtures at T017. Writing a second inverse here is how the two come to disagree.
  //
  // **Matching is by position, not by id, and that is forced rather than chosen.** T017
  // recorded that `id` does not survive rendering: the heading a section carries is the
  // rule's *description*, so `## Style` imports as `style` while the rule is `10-style`.
  // What does survive is order, and `Artifact.provenance.ruleIds` records exactly which
  // canonical rules produced a file and in what sequence — the field's own comment names
  // this task as its consumer.
  const bySource = new Map<string, RuleDocument[]>();
  for (const source of collected.sources) {
    for (const rule of source.rules) {
      const list = bySource.get(rule.source.file);
      if (list === undefined) bySource.set(rule.source.file, [rule]);
      else list.push(rule);
    }
  }

  const byId = new Map(canonical.rules.map((r) => [r.id, r]));
  const proposals = new Map<string, { body: string; from: Set<string> }>();

  for (const path of eligible) {
    const artifact = plan.artifacts.find((a) => a.path === path);
    const ruleIds = artifact?.provenance?.ruleIds;
    const imported = bySource.get(path) ?? [];

    if (ruleIds === undefined) {
      refusals.push({
        path,
        reason: 'unrecoverable',
        detail: 'this adapter does not record which rules produced the file',
      });
      continue;
    }

    // A heading added or removed by hand desynchronizes the zip, and a misaligned merge
    // writes one rule's text into another rule's file — silent, and worse than the edit
    // being lost. Counts must agree or nothing from this file is used.
    if (imported.length !== ruleIds.length) {
      refusals.push({
        path,
        reason: 'unrecoverable',
        detail: `the file now has ${String(imported.length)} sections where ${String(ruleIds.length)} rules produced it; add or remove the rule in .rulegate/rules/ instead`,
      });
      continue;
    }

    for (const [i, id] of ruleIds.entries()) {
      const existing = byId.get(id);
      const edited = imported[i];
      if (existing === undefined || edited === undefined) continue;
      if (edited.body === existing.body) continue;

      const seen = proposals.get(id);
      if (seen === undefined) {
        proposals.set(id, { body: edited.body, from: new Set([path]) });
      } else if (seen.body === edited.body) {
        seen.from.add(path);
      } else {
        // Two generated files were edited differently and both feed one rule. Merging
        // would mean discarding one of two things the user wrote, so both are named and
        // neither is applied.
        refusals.push({
          path,
          reason: 'conflict',
          detail: `rule \`${id}\` was edited differently here and in ${[...seen.from].sort(compareCodepoint).join(', ')}`,
        });
        proposals.delete(id);
      }
    }
  }

  const merged: RuleDocument[] = canonical.rules.map((rule) => {
    const proposal = proposals.get(rule.id);
    return proposal === undefined ? rule : { ...rule, body: proposal.body };
  });

  // Serialized both ways rather than assembled by hand: `serializeCanonical` is what
  // `init` writes and what the parser reads back, so a merge that produced bytes by any
  // other route could write a rule file `sync` then re-reads differently.
  const before = serializeCanonical(canonical);
  const after = serializeCanonical({ ...canonical, rules: merged });

  const merges: RuleMerge[] = [];
  const files: CanonicalFile[] = [];
  for (const rule of merged) {
    const proposal = proposals.get(rule.id);
    if (proposal === undefined) continue;
    const path = rule.path === '' ? undefined : rule.path;
    const [file, contents] =
      path === undefined
        ? ([...after].find(([, text]) => text.includes(proposal.body)) ?? ['', ''])
        : [path, after.get(path) ?? ''];
    if (file === '') continue;

    const previous = before.get(file) ?? '';
    if (previous === contents) continue;

    merges.push({
      id: rule.id,
      path: file,
      before: previous,
      after: contents,
      from: [...proposal.from].sort(compareCodepoint),
    });
    files.push({ path: file, contents, kind: 'modify' });
  }

  merges.sort((a, b) => compareCodepoint(a.path, b.path));
  files.sort((a, b) => compareCodepoint(a.path, b.path));
  refusals.sort((a, b) => compareCodepoint(a.path, b.path));

  return { merges, files, refusals, errors: collected.errors };
}
