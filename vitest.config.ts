import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Aliased to source so `pnpm test` works on a clean clone before `pnpm build`.
    // The trade-off is that nothing here exercises the built dist/ — that gap is
    // covered by the RULEGATE_TEST_DIST-gated smoke test, which CI runs after build.
    alias: {
      '@rulegate/core': src('./packages/core/src/index.ts'),
      // The subpath must come first. Vite matches string aliases by prefix in declaration
      // order, so a bare '@rulegate/adapter-kit' listed above this one would rewrite
      // '@rulegate/adapter-kit/testing' into '.../src/index.ts/testing'.
      '@rulegate/adapter-kit/testing': src('./packages/adapter-kit/src/testing/index.ts'),
      '@rulegate/adapter-kit': src('./packages/adapter-kit/src/index.ts'),
      '@rulegate/adapter-aider': src('./packages/adapters/aider/src/index.ts'),
      '@rulegate/adapter-claude-code': src('./packages/adapters/claude-code/src/index.ts'),
      '@rulegate/adapter-cline': src('./packages/adapters/cline/src/index.ts'),
      '@rulegate/adapter-codex': src('./packages/adapters/codex/src/index.ts'),
      '@rulegate/adapter-copilot': src('./packages/adapters/copilot/src/index.ts'),
      '@rulegate/adapter-cursor': src('./packages/adapters/cursor/src/index.ts'),
      '@rulegate/adapter-gemini': src('./packages/adapters/gemini/src/index.ts'),
      '@rulegate/adapter-roo-code': src('./packages/adapters/roo-code/src/index.ts'),
      '@rulegate/adapter-windsurf': src('./packages/adapters/windsurf/src/index.ts'),
      '@rulegate/adapter-zed': src('./packages/adapters/zed/src/index.ts'),
      '@rulegate/interop': src('./packages/interop/src/index.ts'),
      // `action/` imports the CLI by its published name. Without this the Action's tests
      // would be the only ones running against `dist/`, so they would pass or fail on
      // whatever was last built rather than on the source in the diff.
      rulegate: src('./packages/cli/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'action/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});
