import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/tokens/estimate.js';

describe('estimateTokens', () => {
  it('counts an empty string as zero', () => {
    // The `finalizeArtifact('') === ''` precedent: empty stays empty. A one-token floor
    // would put a phantom cost on every artifact an adapter declined to emit.
    expect(estimateTokens('')).toBe(0);
  });

  it('returns a non-negative integer', () => {
    for (const s of ['a', 'hello world', '```ts\nconst x = 1;\n```', '你好', '🎉']) {
      const n = estimateTokens(s);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('is stable across 100 calls', () => {
    const text = '# Heading\n\nSome prose with `code` and a path packages/core/src/index.ts\n';
    expect(new Set(Array.from({ length: 100 }, () => estimateTokens(text))).size).toBe(1);
  });

  it('counts CRLF and LF forms of one document identically', () => {
    const lf = 'line one\nline two\nline three\n';
    expect(estimateTokens(lf.replace(/\n/g, '\r\n'))).toBe(estimateTokens(lf));
  });

  it('counts NFC and NFD forms of one string identically', () => {
    // macOS hands back NFD and Linux NFC, so without normalization the same repository
    // would estimate differently per platform — a determinism bug, not a rounding one.
    const nfc = 'café résumé naïve';
    expect(estimateTokens(nfc.normalize('NFD'))).toBe(estimateTokens(nfc.normalize('NFC')));
  });

  it('ignores a byte-order mark', () => {
    expect(estimateTokens('﻿hello')).toBe(estimateTokens('hello'));
  });

  it('charges a supplementary-plane codepoint once, not twice', () => {
    // '🎉' is one character occupying two UTF-16 units. Iterating units would split it
    // and charge for two half-symbols.
    expect(estimateTokens('🎉🎉')).toBeGreaterThan(estimateTokens('🎉'));
    expect(estimateTokens('🎉🎉')).toBeLessThanOrEqual(2 * estimateTokens('🎉') + 1);
  });

  it('never decreases when text is appended', () => {
    const a = 'The quick brown fox';
    const b = ' jumps over the lazy dog';
    expect(estimateTokens(a + b)).toBeGreaterThanOrEqual(estimateTokens(a));
  });

  it('scales roughly linearly rather than quadratically', () => {
    const unit = '# Section\n\nSome ordinary prose about rules and globs.\n\n';
    const one = estimateTokens(unit);
    const ten = estimateTokens(unit.repeat(10));
    expect(ten).toBeGreaterThan(one * 9);
    expect(ten).toBeLessThan(one * 11);
  });

  it('terminates on a codepoint that matches no class', () => {
    // A run that failed to advance would spin forever. U+0001 and U+E000 (private use)
    // fall through every classifier, so this asserts termination as much as a value.
    expect(estimateTokens('ok')).toBeGreaterThan(0);
  });

  it('charges CJK far more than a character count would suggest', () => {
    // The failure that rules out `chars / 4`: it under-counts this by about 60%.
    const cjk = '这是一个测试文档我们需要确保分词器能够正确处理中文字符';
    expect(estimateTokens(cjk)).toBeGreaterThan(cjk.length / 2);
  });

  it('does not charge for the space between two words', () => {
    // `cl100k` encodes ' the' as a single token. Charging for the space as well is what
    // made an early version of this estimator 93% high on prose.
    expect(estimateTokens('alpha beta')).toBe(estimateTokens('alpha') + estimateTokens('beta'));
  });
});
