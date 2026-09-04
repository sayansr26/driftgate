import pc from 'picocolors';
import type { RulegateError } from '@rulegate/core';

/** The subset of picocolors this CLI uses, resolved once per run. */
export type Colors = ReturnType<typeof pc.createColors>;

export interface Output {
  readonly quiet: boolean;
  /**
   * Colour functions that are genuinely inert when colour is off.
   *
   * Always go through this rather than importing `picocolors` directly — see
   * `createOutput` for why the module default cannot be trusted to have been disabled.
   */
  readonly c: Colors;
  log(line: string): void;
  error(line: string): void;
}

/**
 * Colour only on a TTY, and never when NO_COLOR is set or --no-color was passed.
 * CI logs and piped output must stay plain: a diff full of escape sequences is a diff
 * nobody reads.
 */
export function createOutput(opts: { quiet?: boolean; color?: boolean } = {}): Output {
  const useColor =
    opts.color !== false && Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];

  // `createColors` *returns* a new object; it does not reconfigure the module default.
  // The previous `if (!useColor) pc.createColors(false)` therefore discarded its only
  // effect, and `pc.red(...)` kept emitting escapes. It was invisible because nothing had
  // printed in colour yet, and it would have stayed invisible on macOS and Linux: picocolors
  // auto-disables when stdout is not a TTY, but forces colour ON for `CI` and for win32, so
  // the first CI run to print colour would have emitted escapes into the log with
  // `--no-color` passed. Deriving both branches from `createColors` leaves nothing to trust.
  const c = pc.createColors(useColor);

  return {
    quiet: opts.quiet === true,
    c,
    log(line: string): void {
      if (opts.quiet !== true) process.stdout.write(`${line}\n`);
    },
    error(line: string): void {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function formatErrors(errors: readonly RulegateError[]): string {
  return errors.map((e) => e.format()).join('\n');
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A token count, as it must appear anywhere a user can read it.
 *
 * The `~` is not decoration: `estimateTokens` is an approximation with a stated ±15%
 * band, and a bare `4,210` reads as a measurement. Core returns a number because a count
 * is data that `doctor` sums and compares against `AdapterDocs.limits`; the admission
 * about precision belongs here, with the rest of the presentation.
 *
 * Grouping is manual. `toLocaleString` is banned by `docs/determinism.md` rule 2 and
 * would additionally vary by host locale, printing `4.210` in a German CI log.
 */
export function formatTokens(count: number): string {
  const digits = String(Math.max(0, Math.round(count)));
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits[i];
  }
  return `~${grouped}`;
}
