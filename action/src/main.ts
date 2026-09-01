/**
 * GitHub Action wrapper for `driftgate check`. A stub until T023 implements `check`;
 * the real, versioned marketplace Action is T053.
 */
export function main(): void {
  process.stderr.write('driftgate action: `check` is not implemented yet (T023).\n');
  process.exitCode = 1;
}
