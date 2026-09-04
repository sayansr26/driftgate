/**
 * The recovery hints `sync` and `check` share.
 *
 * One string per situation, in one place, because `check` reports the same six outcomes
 * `sync` acts on and must hand the user the same next step. Two copies of "what to do
 * about a hand-edited file" is how they come to disagree. Every command and flag named
 * here is checked against the registered program by `test/hints.test.ts`.
 */

/** The canonical source has moved on, or a planned file is missing, or an orphan is due for deletion. */
export const HINT_SYNC = 'hint: run: rulegate sync';

/**
 * Clobbering someone's edit is the one outcome worse than doing nothing.
 *
 * This names only what exists today. It used to advertise the in-place merge flag, which
 * is T051 and unimplemented, so following our own advice produced usage help and exit 2 —
 * the code that means the *user* made a mistake (T075). `test/hints.test.ts` reads every
 * word after a `hint:` to the end of this file, so the flag is not spelled here either.
 */
export const HINT_HAND_EDITED =
  'hint: re-apply your edit in .rulegate/, then delete the generated file so sync' +
  ' can rewrite it.';

/**
 * The escape hatch T075 spent four tasks without. It is a *second* line rather than part
 * of `HINT_HAND_EDITED`, because the two say different things: the first is what to do
 * with no further tooling, and this one is the shortcut, which not every user wants —
 * importing rewrites their canonical source.
 */
export const HINT_IMPORT =
  'hint: or run: rulegate sync --import  (prints the merge; writes nothing without --yes)';

/**
 * A third case, and reusing either message above would be wrong. This file is ours —
 * state.json records it — but no rule produces it any more, so "re-apply your edit in
 * .rulegate/" names a file that no longer has a rule to go back to.
 */
export const HINT_ORPHAN_HAND_EDITED =
  'hint: delete the file yourself to accept the removal, or restore the rule that' +
  ' generated it in .rulegate/rules/';

/**
 * Different problem, different fix: this file is not a stale copy of our output, it is
 * the user's own writing. Telling them to "re-apply it in .rulegate/" as though
 * rulegate had authored it is how a tool talks its way into deleting work.
 */
export const HINT_UNMANAGED =
  'hint: move the file aside to keep it, or run: rulegate sync --force' +
  ' (originals are copied to .rulegate/backup/ first)';
