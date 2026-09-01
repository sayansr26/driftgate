# Line-ending fixtures

`lf/` and `crlf/` hold byte-identical content differing only in line endings. Parsing
and rendering either must produce the same output, byte for byte.

This is not hypothetical: on Windows, `core.autocrlf=true` rewrites line endings at
checkout. If Driftgate were sensitive to that, every generated file would report as
hand-edited on every Windows checkout, and `driftgate check` would fail CI for every
repository on that platform.

These files are protected from git's own EOL translation by `fixtures/** -text` in
`.gitattributes`. Without that line the two directories become identical at checkout
and this fixture silently stops testing anything.
