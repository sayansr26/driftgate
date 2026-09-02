# `doctor/unadopted`

A repository that has **never adopted Driftgate**: no `.driftgate/`, and two hand-written
tool configs that Driftgate did not generate and must not claim.

This is `doctor`'s primary audience and the first thing `init` (T019) will ask of it, so
`E_NO_CANONICAL_SOURCE` here is an ordinary answer — `adopted: false`, exit 0 — and not an
error. A `doctor` that failed on the first command a new user runs would be the T077 bug
with a different name.
