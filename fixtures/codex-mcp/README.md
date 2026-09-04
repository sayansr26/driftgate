# `codex-mcp`

The MCP half of the Codex adapter (T047), and the reason T047 exists: this is the only
target that is not JSON, and it is where the canonical model is checked for quietly
assuming JSON semantics.

`input/.driftgate/mcp/servers.yaml` deliberately diverges from `claude-code-mcp/`,
`cursor-mcp/` and `copilot-mcp/`, which share one file. Two servers had to change, and
both changes are the finding:

- `alpha-http`'s header is `Authorization` rather than `X-Api-Key`. Codex has no general
  header mechanism for a secret — `http_headers` holds static values only — so
  `Authorization` is the single header an `env:` reference can reach, as
  `bearer_token_env_var`. Any other env-ref header is **refused**, not dropped: a header
  silently omitted ships a server that fails to authenticate. That refusal has a unit
  test rather than a golden, because a render that must fail has no `expected/`.
- The variable name is 23 characters. `bearer_token_env_var` flattens to a key containing
  both `bearer` and `token`, so the T044 rendered-bytes scan asks whether the *value*
  looks generated — and an environment variable name that long does. The name in this
  file is what makes that a failing test rather than a latent one.

Three more divergences from the JSON targets:

- **Order is content, and a golden still cannot check it.** TOML tables have no canonical
  order, so the render order decides the bytes — but `parseMcpServers` sorts by id at parse
  time, so this fixture reaches the adapter sorted however `input/` is written. T046
  predicted this file would finally guard `selectMcpServers`' sort and it does not: deleting
  that sort passes every test here. The guard is a unit test that reverses the input.
- **The marker is a `#` comment**, via `withHashMarker` — written at T005 and unused for
  every task since, earmarked in that task's own notes for exactly this file.
- **Codex has no variable substitution at all.** `env: { NAME: env:NAME }` becomes
  `env_vars = ["NAME"]`, a different key with different semantics. A *renamed* reference
  (`API_KEY: env:MY_TOKEN`) has no form here and is refused.

`expected/.codex/config.toml` was hand-written from
<https://learn.chatgpt.com/docs/config-file/config-reference> and
<https://learn.chatgpt.com/docs/extend/mcp> (read 2026-09-04) before the writer existed.
