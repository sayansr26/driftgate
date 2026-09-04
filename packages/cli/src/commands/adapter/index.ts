import {
  NodeFileSystem,
  applyScaffold,
  isRulegateError,
  resolveRepoRoot,
  type ScaffoldFile,
} from '@rulegate/core';
import { ADAPTER_NAMES } from '../../registry.js';
import { createOutput, formatErrors, pluralize } from '../../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../../ui/exit.js';
import { TOOL_ID_PATTERN, toolNames } from './names.js';
import {
  registerInCliPackage,
  registerInRegistry,
  registerInRfc,
  registerInVitestConfig,
} from './register.js';
import { scaffoldFiles } from './templates.js';

export { TOOL_ID_PATTERN, toolNames } from './names.js';
export {
  registerInCliPackage,
  registerInRegistry,
  registerInRfc,
  registerInVitestConfig,
} from './register.js';
export { scaffoldFiles } from './templates.js';

export interface AdapterNewOptions {
  readonly cwd: string;
  /** The adapter's id, which is also its package directory name. */
  readonly tool: string;
  /** Apply the plan. Without it nothing is written. */
  readonly yes?: boolean;
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

/** The registry, its dependency list, and the test alias — the three files a new adapter joins. */
const REGISTRY = 'packages/cli/src/registry.ts';
const CLI_PACKAGE = 'packages/cli/package.json';
const VITEST_CONFIG = 'vitest.config.ts';
const RFC = 'docs/rfc-0001-canonical-format.md';

/**
 * `rulegate adapter new <tool>` — the contribution funnel (T028).
 *
 * Adapters are how this project grows, so the distance from "I want tool X supported" to
 * a green test is a growth feature rather than a convenience. The scaffold produces a
 * *working* adapter, its fixtures, its tests, and its registration; what is left is the
 * roughly twenty lines only the contributor can write — the real file path, the real
 * precedence rules, and a hand-written golden.
 *
 * Like `init` and `restore` it prints the plan and writes nothing without `--yes`, and
 * like them it never overwrites: every generated path must be absent, and the three
 * patched files must exist. A half-applied scaffold is worse than none.
 */
export async function runAdapterNew(options: AdapterNewOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = new NodeFileSystem(repoRoot);

  const tool = options.tool.trim();
  if (!TOOL_ID_PATTERN.test(tool)) {
    // Usage, not failure: the id becomes a directory name, a package name and an exported
    // binding, and CI must be able to tell a typo from drift.
    out.error(`\`${tool}\` is not a valid adapter id`);
    out.error('hint: lowercase, kebab-case, like `claude-code` or `kiro`.');
    return ExitCode.Usage;
  }

  if (ADAPTER_NAMES.includes(tool)) {
    out.error(`an adapter named \`${tool}\` already ships in this build`);
    out.error(`hint: edit packages/adapters/${tool}/ instead.`);
    return ExitCode.Usage;
  }

  for (const required of [REGISTRY, CLI_PACKAGE, VITEST_CONFIG, RFC]) {
    if (await fs.exists(required)) continue;
    // The scaffold writes into *this* monorepo, not into a user's repository. Saying so
    // up front is better than a patch failure three steps later.
    out.error(`${repoRoot} is not a checkout of the rulegate monorepo (${required} is missing)`);
    out.error('hint: adapters live in the rulegate repository; clone it and run this there.');
    return ExitCode.Usage;
  }

  const n = toolNames(tool);

  let files: readonly ScaffoldFile[];
  try {
    files = [
      ...scaffoldFiles(tool),
      {
        path: REGISTRY,
        contents: registerInRegistry(await fs.readFile(REGISTRY), tool),
        kind: 'update',
      },
      {
        path: CLI_PACKAGE,
        contents: registerInCliPackage(await fs.readFile(CLI_PACKAGE), tool),
        kind: 'update',
      },
      {
        path: VITEST_CONFIG,
        contents: registerInVitestConfig(await fs.readFile(VITEST_CONFIG), tool),
        kind: 'update',
      },
      { path: RFC, contents: registerInRfc(await fs.readFile(RFC), tool), kind: 'update' },
    ];
  } catch (error) {
    if (!isRulegateError(error)) throw error;
    out.error(formatErrors([error]));
    return ExitCode.Failure;
  }

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  const apply = options.yes === true;

  let report;
  try {
    report = await applyScaffold(files, fs, { dryRun: !apply });
  } catch (error) {
    if (!isRulegateError(error)) throw error;
    out.error(formatErrors([error]));
    out.error('\nnothing was written.');
    return ExitCode.Failure;
  }

  for (const path of report.created) out.log(`${apply ? 'created' : 'would create'}  ${path}`);
  for (const path of report.updated)
    out.log(`${apply ? 'registered in' : 'would register in'}  ${path}`);

  if (!apply) {
    out.log('');
    out.log(
      `${pluralize(report.created.length, 'file')} to create, ${pluralize(report.updated.length, 'file')} to patch.`,
    );
    out.log(`nothing was written. run: rulegate adapter new ${tool} --yes`);
    return ExitCode.Ok;
  }

  out.log('');
  out.log(`${n.title} scaffolded. next:`);
  out.log('  pnpm install && pnpm test');
  out.log('      green as generated, so the next failure you see is a real one');
  out.log(`  fixtures/${tool}/expected/${n.artifact}`);
  out.log('      hand-write it from the tool docs; the golden here was generated');
  out.log(`  packages/adapters/${tool}/src/docs.ts`);
  out.log('      replace every TODO — doctor answers "which file wins" from that file');
  // The manifest enumerates tools, so registering an adapter does not enable it here.
  // Saying how to dogfood it is the difference between an adapter that is tested against
  // fixtures and one that has been run on a real repository — this one.
  out.log('');
  out.log(`then: add \`${tool}\` to .rulegate/rulegate.yaml and run rulegate sync`);
  out.log(`      this repo dogfoods every adapter it ships; commit ${n.artifact} with your change`);

  return ExitCode.Ok;
}
