import {
  diffLines,
  HINT_HAND_EDITED,
  HINT_ORPHAN_HAND_EDITED,
  HINT_SYNC,
  HINT_UNMANAGED,
  type VerifyEntry,
  type VerifyReport,
  type VerifyStatus,
} from 'rulegate';

/**
 * GitHub renders at most ten annotations per level per step. Emitting more is not an
 * error — they are simply dropped — so the cap is explicit and the overflow is counted,
 * because a repository with forty drifted regions must not silently look like one with
 * ten.
 */
export const MAX_ANNOTATIONS = 10;

/**
 * What to do about each status, in the words the CLI already uses.
 *
 * These are the strings from `ui/hints.ts`, not a second set written for the Action. Two
 * copies of "what to do about a hand-edited file" is how they come to disagree — the same
 * reason `sync` and `check` share one hint module.
 */
const RECOVERY: Readonly<Record<VerifyStatus, string>> = {
  stale: HINT_SYNC,
  missing: HINT_SYNC,
  orphaned: HINT_SYNC,
  'hand-edited': HINT_HAND_EDITED,
  'orphan-hand-edited': HINT_ORPHAN_HAND_EDITED,
  unmanaged: HINT_UNMANAGED,
};

/** What each status means, for a reader who is looking at a PR diff rather than a terminal. */
const EXPLANATION: Readonly<Record<VerifyStatus, string>> = {
  stale: 'This generated file is out of date: .rulegate/ has moved on.',
  missing: 'This generated file is missing.',
  orphaned: 'No enabled adapter generates this file any more.',
  'hand-edited': 'This generated file was edited by hand; the edit would be overwritten.',
  'orphan-hand-edited':
    'This file was edited by hand and no rule generates it any more, so it cannot be regenerated.',
  unmanaged: 'A file rulegate did not generate is standing where its output goes.',
};

/**
 * Escape a workflow-command **message**.
 *
 * An unescaped newline ends the command, so everything after it is printed as ordinary
 * log output and the annotation is silently truncated — a failure that looks like a
 * formatting quirk rather than a bug.
 *
 * The `%` substitution must run first, or it re-escapes the `%` of the substitutions
 * that follow it.
 */
export function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Escape a workflow-command **property** value.
 *
 * Properties are `key=value` pairs separated by `,` and terminated by `::`, so a value
 * containing either would be reparsed as the start of another property. Paths do not
 * usually contain them; titles and Windows-style drive prefixes can.
 */
export function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

interface Annotation {
  readonly file: string;
  /** Absent for a whole-file annotation: a missing file and an orphan have no line to point at. */
  readonly line?: number;
  readonly endLine?: number;
  readonly title: string;
  readonly message: string;
}

function format(a: Annotation): string {
  const props = [`file=${escapeProperty(a.file)}`];
  if (a.line !== undefined) props.push(`line=${String(a.line)}`);
  if (a.endLine !== undefined) props.push(`endLine=${String(a.endLine)}`);
  props.push(`title=${escapeProperty(a.title)}`);
  return `::error ${props.join(',')}::${escapeData(a.message)}`;
}

/**
 * The annotations for one out-of-sync path.
 *
 * An entry with both sides gets one annotation per changed region, so the reviewer sees
 * the drift on the lines it actually affects. The coordinates come from `Hunk.oldStart`
 * and `oldLines`, which are positions in the file **on disk** — the side GitHub is
 * rendering. Using the render's coordinates would put the marker on the right file and
 * the wrong lines, which is worse than no marker at all.
 *
 * `missing` and `orphaned` have only one side, so there is nothing to point at within
 * them and they get a single whole-file annotation. `line=1` would be a fabricated
 * location.
 */
export function annotationsFor(entry: VerifyEntry): Annotation[] {
  const title = `rulegate: ${entry.status}`;
  const message = `${EXPLANATION[entry.status]}\n${RECOVERY[entry.status]}`;

  if (entry.expected === undefined || entry.actual === undefined) {
    return [{ file: entry.path, title, message }];
  }

  return diffLines(entry.actual, entry.expected).map((hunk) => ({
    file: entry.path,
    // A pure insertion at the top of the file has `oldStart: 0`, and GitHub's lines are
    // 1-based. `oldLines` is 0 for that same case, so `endLine` must not run backwards.
    line: Math.max(1, hunk.oldStart),
    endLine: Math.max(1, hunk.oldStart + Math.max(0, hunk.oldLines - 1)),
    title,
    message,
  }));
}

/**
 * Turn a check's report into workflow commands, ready to print one per line.
 *
 * Pure: it writes nothing and reads nothing. The Action's only side effect is printing
 * these, which keeps `action/src` inside the write allowlist that
 * `invariants.test.ts` enforces across all shipped source.
 */
export function renderAnnotations(report: VerifyReport): string[] {
  const all = report.entries.flatMap(annotationsFor);
  const shown = all.slice(0, MAX_ANNOTATIONS).map(format);
  if (all.length > shown.length) {
    const hidden = all.length - shown.length;
    shown.push(
      `::notice::${escapeData(
        `${String(hidden)} more drifted ${hidden === 1 ? 'region' : 'regions'} not annotated` +
          ` (github shows at most ${String(MAX_ANNOTATIONS)} per step); the full diff is in the log above.`,
      )}`,
    );
  }
  return shown;
}
