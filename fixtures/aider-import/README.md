# `aider-import`

`.aider.conf.yml` is here **on purpose**, carrying a distinctive non-credential setting.

The assertion this fixture exists for is that `read()` never imports a line of the user's
config file. A fixture holding only `CONVENTIONS.md` would run that assertion where the
hazard is absent — it would pass against an adapter that could not have failed, which is the
inert-guard shape this repository has recorded two dozen times. With the config present, an
adapter that widened `read()` to `tryReadFile('.aider.conf.yml')` fails immediately.

The setting is deliberately not a credential. `packages/core/test/secrets.test.ts` scans
**every file under `fixtures/`**, so a realistic-looking key here turns that suite red — and
the hazard being guarded is "config content reaches canonical", which needs no real secret to
express. Aider's config *can* hold literal API keys (`--openai-api-key` is a documented
YAML-expressible option), and that is precisely why the adapter never reads this file; it is
not a reason to commit one into a fixture.

Aider is detected by the **config**, never by `CONVENTIONS.md`: `sync` writes that file
itself, so treating it as evidence would make every synced repository detect Aider forever
and make `doctor` unfalsifiable.
