import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/tokens/estimate.js';

/**
 * T024's stated validation: estimates land within ±15% of a reference tokenizer on five
 * sample documents, with no network access and no model download.
 *
 * `gpt-tokenizer` is a **root devDependency**, never a runtime one. The allowlist in
 * `invariants.test.ts` covers `dependencies` of the published packages, and this import
 * lives in a test — but the reason it is acceptable is not that the guard misses it. It is
 * that the shipped estimator carries no tokenizer at all: this file exists to prove the
 * approximation is good enough that Rulegate never needs to ship 1.5 MB of BPE ranks.
 */

const fixtures = fileURLToPath(new URL('../../../fixtures/tokens/', import.meta.url));

interface ReferenceEntry {
  readonly document: string;
  readonly chars: number;
  readonly referenceTokens: number;
}

interface ReferenceFile {
  readonly tokenizer: string;
  readonly version: string;
  readonly encoding: string;
  readonly retrieved: string;
  readonly documents: readonly ReferenceEntry[];
}

async function loadReference(): Promise<ReferenceFile> {
  return JSON.parse(await readFile(path.join(fixtures, 'reference.json'), 'utf8')) as ReferenceFile;
}

async function loadDocument(name: string): Promise<string> {
  return readFile(path.join(fixtures, 'documents', name), 'utf8');
}

/**
 * Which documents an estimator misses by more than `band`.
 *
 * Exported shape rather than an inline loop so that the mutation guards below run the
 * *identical* comparison against a deliberately wrong estimator. A control that takes a
 * different path than the claim it vouches for is not a control.
 */
async function accuracyFailures(
  estimator: (text: string) => number,
  band = 0.15,
): Promise<string[]> {
  const reference = await loadReference();
  const failures: string[] = [];
  for (const entry of reference.documents) {
    const text = await loadDocument(entry.document);
    const estimated = estimator(text);
    const error = Math.abs(estimated - entry.referenceTokens) / entry.referenceTokens;
    if (error > band) {
      failures.push(
        `${entry.document}: estimated ${String(estimated)} vs ${String(entry.referenceTokens)} (${(error * 100).toFixed(1)}%)`,
      );
    }
  }
  return failures;
}

describe('reference accuracy', () => {
  it('reads five frozen sample documents, each over 500 characters', async () => {
    // The anti-vacuity guard. Every assertion below loops over this list, so if the
    // directory is renamed or emptied they would all pass over nothing. This is the one
    // that fails instead — the plainest form of this repository's signature bug.
    const reference = await loadReference();
    expect(reference.documents).toHaveLength(5);
    for (const entry of reference.documents) {
      const text = await loadDocument(entry.document);
      expect(text.length).toBeGreaterThan(500);
      expect(text.length).toBe(entry.chars);
    }
  });

  it('records the provenance of every reference count', async () => {
    const reference = await loadReference();
    // A committed number with no stated origin cannot be re-derived by a reviewer, and a
    // count nobody can reproduce is decoration.
    expect(reference.tokenizer).toBe('gpt-tokenizer');
    expect(reference.encoding).toBe('cl100k_base');
    expect(reference.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(reference.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has committed counts that the reference tokenizer still agrees with', async () => {
    // Re-derived rather than trusted. Otherwise the tempting way to fix a failing
    // accuracy test is to regenerate the expectation from the estimator, at which point
    // the suite measures whether the estimator agrees with itself.
    const reference = await loadReference();
    for (const entry of reference.documents) {
      expect(encode(await loadDocument(entry.document))).toHaveLength(entry.referenceTokens);
    }
  });

  it('lands within 15% on every sample document', async () => {
    expect(await accuracyFailures(estimateTokens)).toEqual([]);
  });

  it('lands within 8% in aggregate', async () => {
    // A per-document band alone permits a systematic bias that happens to fit inside it.
    const reference = await loadReference();
    let estimated = 0;
    let actual = 0;
    for (const entry of reference.documents) {
      estimated += estimateTokens(await loadDocument(entry.document));
      actual += entry.referenceTokens;
    }
    expect(Math.abs(estimated - actual) / actual).toBeLessThanOrEqual(0.08);
  });

  describe('the accuracy harness is capable of failing', () => {
    /**
     * Two positive controls that ship and run in CI forever, rather than mutations run
     * once by hand and then trusted.
     *
     * ±15% is a wide band, and a sloppy estimator can sit inside it by luck. This
     * repository's recorded failure mode is a guard that has never been made to fail, so
     * the harness is made to fail here, through the same helper as the claim above.
     */
    it('rejects an estimator that reports half the true count', async () => {
      const failures = await accuracyFailures((s) => Math.round(estimateTokens(s) / 2));
      // All five, not merely one: that is what proves the helper reads every document
      // rather than tripping on the first and returning.
      expect(failures).toHaveLength(5);
    });

    it('rejects naive chars/4 on the adversarial document', async () => {
      const failures = await accuracyFailures((s) => Math.round(s.length / 4));
      // Doubles as the recorded evidence for choosing a class-weighted pretokenizer over
      // `chars / 4`. If a later refactor ever lets `chars / 4` pass here, the fixtures
      // have gone soft and this says so.
      expect(failures.join('\n')).toContain('05-adversarial.md');
    });
  });
});
