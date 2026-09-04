import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rules below are not style preferences. They are the mechanical enforcement of
 * the permanent invariants in memory-bank/03-system-patterns.md: zero network calls,
 * adapters are pure, core knows nothing tool-specific, and rendering is deterministic.
 * A lint rule catches these at author time; a code review does not.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', 'fixtures/**', 'coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated lint project: the per-package build tsconfigs deliberately
        // exclude tests and root config files, but those still need linting.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='os'][property.name='EOL']",
          message: 'os.EOL is platform-dependent; Driftgate always emits \\n.',
        },
        {
          selector: "MemberExpression[property.name='localeCompare']",
          message: 'localeCompare depends on locale and ICU version; use compareCodepoint().',
        },
      ],
    },
  },
  {
    // Adapters are pure: they return Artifacts and never touch the world themselves.
    // This is what makes `check` and `sync` structurally incapable of diverging.
    files: ['packages/adapters/*/src/**/*.ts'],
    ignores: ['packages/adapters/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // The frozen contract is @driftgate/adapter-kit (T011). Reaching past it into
          // core is how an adapter comes to depend on something that is not promised to
          // external contributors — and it is how our own two adapters would stop being
          // proof that the contract is sufficient.
          patterns: [
            {
              group: ['@driftgate/core', '@driftgate/core/*'],
              message:
                'Adapters import from @driftgate/adapter-kit, the frozen contract. If a symbol is missing, add it to the kit — additions are non-breaking.',
            },
          ],
          paths: [
            { name: 'fs', message: 'Adapters must not touch the filesystem; use ctx.fs.' },
            { name: 'node:fs', message: 'Adapters must not touch the filesystem; use ctx.fs.' },
            {
              name: 'node:fs/promises',
              message: 'Adapters must not touch the filesystem; use ctx.fs.',
            },
            { name: 'node:child_process', message: 'Adapters must not spawn processes.' },
            { name: 'node:http', message: 'Zero network calls, in any code path, ever.' },
            { name: 'node:https', message: 'Zero network calls, in any code path, ever.' },
            { name: 'node:net', message: 'Zero network calls, in any code path, ever.' },
            {
              // path.join emits backslashes on Windows, which would land in Artifact.path
              // and hash into state.json. Banning it is only honest because the kit ships
              // joinPosix/toPosix/dirnamePosix/basenamePosix as the lawful alternative.
              name: 'node:path',
              message: 'Artifact paths are POSIX; use joinPosix/toPosix from the kit.',
            },
            { name: 'node:os', message: 'Nothing in an adapter may depend on the host OS.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Zero network calls, in any code path, ever.' },
      ],
    },
  },
  {
    // No tool-specific logic in core, and no filesystem access outside the io boundary.
    files: ['packages/core/src/**/*.ts'],
    // `src/git/` is the one directory allowed to spawn a process (T052), and it is the
    // *only* exemption — `invariants.test.ts` pins that allowlist to a single entry, so
    // this ignore and that list have to be changed together to grow a second one.
    ignores: [
      'packages/core/src/io/**',
      'packages/core/src/git/**',
      'packages/core/src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@driftgate/adapter-*'],
          paths: [
            { name: 'node:fs', message: 'Filesystem access belongs in core/src/io only.' },
            {
              name: 'node:fs/promises',
              message: 'Filesystem access belongs in core/src/io only.',
            },
            {
              // Only `core/src/git/` spawns anything, and only three read-only git
              // subcommands (T052). `invariants.test.ts` scans everywhere else.
              name: 'node:child_process',
              message: 'Only core/src/git may spawn a process, and only read-only git.',
            },
          ],
        },
      ],
    },
  },
  {
    // Adapter *tests* may use Node freely, but not the core bypass: a test that imports
    // core is where the next adapter author copies their import block from.
    files: ['packages/adapters/*/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@driftgate/core', '@driftgate/core/*'],
              message:
                'Adapters and their tests import from @driftgate/adapter-kit (contract) and @driftgate/adapter-kit/testing (harness).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Repo tooling, not shipped code. It runs on Node directly and imports the *built*
    // `dist/`, whose types are not available to the linter, so the type-checked rules
    // would report `any` on every line of a correct file. Turning them off here is
    // honest; adding casts to satisfy them would not be. Everything that guards the
    // product — the dependency allowlist, the write allowlist, the network and
    // determinism scans — is a test over `packages/` and is unaffected.
    files: ['scripts/**/*.mjs', 'action/build.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { URL: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
);
