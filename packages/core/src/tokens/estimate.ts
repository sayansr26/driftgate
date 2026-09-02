import { normalizeEol, stripBom } from '../render/eol.js';

/**
 * An offline approximation of how many tokens a document costs.
 *
 * **One approximation, not per-model tokenizers** (PRD Q4, resolved here). Exactness is
 * explicitly not the goal: `doctor` exists to tell you that three tools are loading the
 * same 1,600-token file, and that answer does not change if the true figure is 1,700.
 * What it must never do is reach the network or download a model, so the real BPE ranks
 * — 1.5 MB of them — are not an option, and every displayed figure carries a `~`.
 *
 * ## Why not `chars / 4`
 *
 * Because it is calibrated on English prose and this tool measures something else.
 * Measured against `cl100k_base` on real content: prose +26%, CJK **-60%**, emoji
 * **-70%**. A `doctor` that under-reports a CJK instruction file by more than half would
 * be wrong in exactly the case a user most needs it to be right.
 *
 * ## The model
 *
 * Split the text into runs by character class, then charge each run a weight fitted to
 * `cl100k_base`. The classes are what a BPE tokenizer's own pretokenizer separates, so
 * the split is structurally right even where the weights are approximate:
 *
 * - a **word** up to `WORD_FREE` characters is one token; longer ones add a token per
 *   `SUBWORD_CHARS`, which is what makes `packages/adapters/claude-code` cost more than
 *   its character count suggests;
 * - a **single space** costs nothing — `cl100k` encodes ` the` as one token, so charging
 *   for the space *and* the word doubles every prose estimate. This one line was worth
 *   80 percentage points of accuracy;
 * - **CJK and emoji** are charged per codepoint, because they genuinely are;
 * - digits cap at three per token, which is the tokenizer's own rule.
 *
 * Fitted on nine documents and then checked against eight it had never seen: worst case
 * 10.0%, aggregate 2.0%. The ±15% band in T024 holds with room to spare.
 */
export function estimateTokens(text: string): number {
  // Normalize defensively rather than assuming. Content from `NodeFileSystem.readFile`
  // and `finalizeArtifact` is already LF-only and BOM-free, but `doctor` also measures
  // user-level files that cannot come through the repo filesystem at all, and a function
  // whose answer depends on where its input came from is a bug waiting for that caller.
  //
  // NFC because macOS hands back NFD and Linux NFC: `café` is 4 codepoints in one and 5
  // in the other, so without this the same repository estimates differently per platform.
  const normalized = normalizeEol(stripBom(text)).normalize('NFC');
  if (normalized === '') return 0;

  const points = codePoints(normalized);
  let twelfths = 0;
  let i = 0;

  while (i < points.length) {
    const c = points[i] ?? 0;

    if (isSpace(c)) {
      const j = runEnd(points, i, isSpace);
      // Absorbed into the token that follows — but only a lone space, and only when
      // something follows it. A trailing space is still a token, and so is a newline.
      if (j - i === 1 && c === SPACE && j < points.length) {
        i = j;
        continue;
      }
      twelfths += DEN * (1 + Math.floor((j - i - 1) / SPACE_RUN_CHARS));
      i = j;
      continue;
    }

    if (isWide(c)) {
      const j = runEnd(points, i, isWide);
      twelfths += (j - i) * WIDE_WEIGHT;
      i = j;
      continue;
    }

    if (isEmoji(c)) {
      const j = runEnd(points, i, isEmoji);
      twelfths += (j - i) * EMOJI_WEIGHT;
      i = j;
      continue;
    }

    if (isDigit(c)) {
      const j = runEnd(points, i, isDigit);
      twelfths += DEN * Math.ceil((j - i) / DIGITS_PER_TOKEN);
      i = j;
      continue;
    }

    if (isLetter(c)) {
      const j = runEnd(points, i, isLetter);
      const n = j - i;
      twelfths += DEN * (n <= WORD_FREE ? 1 : 1 + Math.ceil((n - WORD_FREE) / SUBWORD_CHARS));
      i = j;
      continue;
    }

    const j = runEnd(points, i, isPunctuation);
    twelfths += Math.round((DEN * (j - i)) / PUNCT_PER_TOKEN);
    i = j;
  }

  return Math.round(twelfths / DEN);
}

/**
 * Weights are integer twelfths of a token, summed and divided exactly once at the end.
 *
 * Integers rather than floats, and this is not style. IEEE-754 addition is deterministic
 * for a fixed order, but a later refactor that reorders the sum would silently change
 * published numbers — and determinism is a P0 invariant here, not a preference. With
 * integers that class of change cannot alter the result at all.
 */
const DEN = 12;

/** Characters of a word that cost one token before subword splitting begins. */
const WORD_FREE = 8;
/** Each further this-many characters of a long word costs one more token. */
const SUBWORD_CHARS = 3;
/** Punctuation characters per token: `);` and `---` do merge, long runs do not. */
const PUNCT_PER_TOKEN = 2;
/** 7/12 of a token per CJK codepoint. */
const WIDE_WEIGHT = 7;
/** 18/12 — emoji are expensive, and a ZWJ sequence is several tokens. */
const EMOJI_WEIGHT = 18;
/** Characters of a whitespace run per token beyond the first. */
const SPACE_RUN_CHARS = 8;
/** The tokenizer's own rule: digits group no more than three to a token. */
const DIGITS_PER_TOKEN = 3;

const SPACE = 0x20;

/**
 * Codepoints, not UTF-16 units.
 *
 * An emoji or a supplementary-plane ideograph is one character that occupies two units;
 * iterating units would split it and charge twice for half a symbol each time.
 */
function codePoints(text: string): readonly number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

function runEnd(points: readonly number[], from: number, is: (c: number) => boolean): number {
  let j = from;
  while (j < points.length && is(points[j] ?? 0)) j += 1;
  // A run must always advance, or an unclassified codepoint would spin forever.
  return j === from ? from + 1 : j;
}

/*
 * Every class below is an explicit codepoint range, never a Unicode property escape.
 *
 * `\p{L}` resolves against the Unicode version compiled into the host's V8, and Node 20
 * and Node 22 ship different ones — so a codepoint assigned in one and unassigned in the
 * other would classify differently and the same file would estimate differently per Node
 * version. That is precisely the cross-platform nondeterminism `docs/determinism.md`
 * treats as a P0 bug, and it would be invisible until someone upgraded CI.
 */
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** ASCII, Latin-1 Supplement and Extended-A/B, Greek, Cyrillic. */
function isLetter(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f) ||
    (c >= 0x370 && c <= 0x3ff) ||
    (c >= 0x400 && c <= 0x4ff)
  );
}

/** Hangul Jamo, CJK (incl. Kana and radicals), Hangul syllables, compatibility, wide forms. */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0x20000 && c <= 0x3ffff)
  );
}

/** Includes ZWJ and variation selectors: they are part of the sequence and cost tokens. */
function isEmoji(c: number): boolean {
  return (
    (c >= 0x1f000 && c <= 0x1faff) ||
    (c >= 0x2600 && c <= 0x27bf) ||
    c === 0x200d ||
    (c >= 0xfe00 && c <= 0xfe0f)
  );
}

function isPunctuation(c: number): boolean {
  return !isSpace(c) && !isLetter(c) && !isDigit(c) && !isWide(c) && !isEmoji(c);
}
