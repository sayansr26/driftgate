# Malformed input fixtures

Each directory is a repository whose canonical source is broken in one specific way.
The parser must produce an actionable message naming the file, the line, and the
offending field — never a stack trace, and never a silent wrong answer.

`rulegate check` and `sync` refuse to run when any of these fire.

| Fixture | Failure |
|---|---|
| `unterminated-frontmatter` | `---` opened and never closed. |
| `unquoted-glob` | `globs: *.ts` — a bare `*` opens a YAML alias, so the glob silently becomes nothing. |
| `wrong-type` | `order: high` — valid YAML, wrong type. The case a schema library could not give a line number for. |
| `unknown-tool` | A tool id that no adapter claims, one character from a real one. |
| `bad-manifest` | `tools` written as a mapping instead of a list. |

A sixth case — two rule files whose ids collide after NFC normalization — is exercised
in memory rather than here, because APFS normalizes filenames on lookup and silently
merges the two files, so the collision cannot be reproduced on macOS at all. On ext4 it
can. That difference is exactly why rule ids are NFC-normalized in the first place.
