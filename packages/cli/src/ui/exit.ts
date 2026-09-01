/**
 * 0 success, 1 drift or command failure, 2 usage error.
 *
 * Keeping usage errors distinct from drift matters because CI reads the code, not the
 * message: a typo in a workflow file must not be reported as configuration drift.
 */
export const ExitCode = { Ok: 0, Failure: 1, Usage: 2 } as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
