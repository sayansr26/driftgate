# Adversarial sample

Deliberately hostile to a character-count heuristic. Every section below is a class of
content that `chars / 4` gets wrong in a different direction.

## Long paths and globs

- `packages/adapters/claude-code/src/index.ts`
- `packages/core/src/pipeline/plan.ts`
- `.github/instructions/*.instructions.md`
- `**/*.{ts,tsx,mts,cts}`
- `packages/adapters/*/test/self-reference.test.ts`

## A fenced code block

```ts
export function computePlan(input: PlanInput): Promise<Plan> {
  const { fs, repoRoot, adapters } = input;
  const claimedBy = new Map<string, ToolId>();
  return { canonical, artifacts: sortArtifacts(artifacts), errors, warnings };
}
```

## JSON

```json
{ "schemaVersion": 1, "artifacts": [{ "path": "CLAUDE.md", "hash": "d77bd461e691" }] }
```

## CJK

这是一个测试文档。我们需要确保分词器能够正确处理中文字符和日本語のテキスト。
한국어 텍스트도 포함되어 있습니다.

## Cyrillic and Greek

Это тестовая строка. Καλημέρα κόσμε.

## Emoji, including a ZWJ sequence

🎉 👨‍👩‍👧‍👦 🚀 ✅ ⚠️

## A punctuation run

------------------------------------------------------------

## A very long single line

Rulegate keeps one canonical set of AI-agent instructions in `.rulegate/` and generates each tool native config from it, which is a deliberately long line that no formatter will wrap because this file is in .prettierignore and that is the point of it being here.
A CRLF section follows.
Second line with a carriage return.

## More CJK, because a character count is worst here

这是一个测试文档。我们需要确保分词器能够正确处理中文字符和日本語のテキスト。
分词器必须正确处理这些字符，否则文档的令牌估计将会严重偏低。
한국어 텍스트도 포함되어 있습니다. 토크나이저는 이것을 올바르게 처리해야 합니다.
日本語の文章もここに含まれています。トークナイザはこれを正しく数える必要があります。
中文、日本語、한국어 — 三種類の文字体系が一つの段落に混在しています。
每一个字符都比英文字符昂贵得多，这正是字符计数失败的地方。

## More emoji, including ZWJ sequences

🎉 👨‍👩‍👧‍👦 🚀 ✅ ⚠️ 🔥 💡 📦 🧪 🛠️ 🎯 📊 🔍 ⚙️ 🌍 🧭 🪄 🧵 🧱 🪟
👩‍💻 👨‍🚀 🧑‍🔬 👨‍👨‍👦‍👦 👩‍❤️‍💋‍👨 🏳️‍🌈 🏴‍☠️ 👨‍👩‍👧 🧑‍🤝‍🧑 💇‍♀️
🎉 👨‍👩‍👧‍👦 🚀 ✅ ⚠️ 🔥 💡 📦 🧪 🛠️ 🎯 📊 🔍 ⚙️ 🌍 🧭 🪄 🧵 🧱 🪟

A CRLF section follows.
Second line with a carriage return.
