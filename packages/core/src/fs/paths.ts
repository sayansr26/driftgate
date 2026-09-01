import path from 'node:path';

/**
 * Every path that crosses a Driftgate boundary — into the model, into an Artifact,
 * into state.json, or into generated file content — is repo-relative and POSIX-separated.
 * Native separators exist only in `repoRoot` and inside the io layer.
 */

export function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

export function fromPosix(p: string): string {
  return p.split('/').join(path.sep);
}

/** Collapse `.` and `..` segments and strip leading/trailing slashes. Purely lexical. */
export function normalizeRelative(p: string): string {
  const out: string[] = [];
  for (const seg of toPosix(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * True when a path is absolute, or when its `..` segments would take it above the
 * repository root. Callers turn this into E_PATH_ESCAPE; `sync` never writes outside
 * the repo, so this check sits at the io boundary rather than being left to adapters.
 */
export function escapesRoot(relPath: string): boolean {
  if (relPath === '') return true;
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) return true;
  let depth = 0;
  for (const seg of toPosix(relPath).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

export function joinPosix(...parts: readonly string[]): string {
  return normalizeRelative(parts.filter((p) => p !== '').join('/'));
}

export function dirnamePosix(p: string): string {
  const norm = normalizeRelative(p);
  const i = norm.lastIndexOf('/');
  return i === -1 ? '' : norm.slice(0, i);
}

export function basenamePosix(p: string): string {
  const norm = normalizeRelative(p);
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}
