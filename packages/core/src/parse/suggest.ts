/**
 * Levenshtein distance, capped. Used only to turn `cursorr` into
 * "did you mean `cursor`?" — a typo in a tool id is otherwise a silently ignored
 * config line, which is the worst way for this to fail.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i, ...Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** The closest candidate within a small edit distance, or undefined. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  const threshold = input.length <= 4 ? 1 : 2;
  let best: { value: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance <= threshold && (best === undefined || distance < best.distance)) {
      best = { value: candidate, distance };
    }
  }
  return best?.value;
}
