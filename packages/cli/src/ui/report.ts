import pc from 'picocolors';
import type { DriftgateError } from '@driftgate/core';

export interface Output {
  readonly quiet: boolean;
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
  if (!useColor) pc.createColors(false);

  return {
    quiet: opts.quiet === true,
    log(line: string): void {
      if (opts.quiet !== true) process.stdout.write(`${line}\n`);
    },
    error(line: string): void {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function formatErrors(errors: readonly DriftgateError[]): string {
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
