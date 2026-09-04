# `doctor/unadopted`

A repository that has **never adopted Rulegate**: no `.rulegate/`, and two hand-written
tool configs that Rulegate did not generate and must not claim.

This is `doctor`'s primary audience and the first thing `init` (T019) will ask of it, so
`E_NO_CANONICAL_SOURCE` here is an ordinary answer — `adopted: false`, exit 0 — and not an
error. A `doctor` that failed on the first command a new user runs would be the T077 bug
with a different name.
