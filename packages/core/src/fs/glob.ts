/**
 * A deliberately small glob matcher. Rulegate's own needs are narrow — `**`, `*`, `?`
 * and character classes over POSIX paths — and a dependency here would be a
 * supply-chain surface in a tool whose whole pitch is a thin dependency tree.
 *
 * Semantics follow the common convention: `*` does not cross `/`, `**` does.
 */

function escapeLiteral(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        const after = pattern[i + 2];
        if (after === '/') {
          // `**/` also matches zero directories, so `**/*.md` matches `a.md`.
          re += '(?:[^/]*(?:/|$))*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = close + 1;
        continue;
      }
      re += '\\[';
      i += 1;
      continue;
    }
    re += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPath);
}
