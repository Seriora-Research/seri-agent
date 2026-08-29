# Config and API keys

Per-profile settings and BYOK API keys live in `~\.seri\<profile>\config.json`. The TUI paths are `/setup` (provider keys) and `/config` (non-provider settings); `seri config set|list|unset` is the non-interactive subcommand exception — and it is slated for removal in favor of the TUI `/config` panel, so treat it as the exception it is, not a stable fallback.

## Sub-features

- `config-set` `config set KEY VALUE` writes the key to the profile's config.json.
- `config-list` `config list` prints every key with the value masked.
- `config-unset` `config unset KEY` removes it.
- `config-env-shadow` `list` flags a key whose value an environment variable currently overrides (env beats config.json).
- `config-tui-setup` `/setup` in the TUI adds/replaces/removes a provider key, probing it with one lightweight request.

## How to get to it (user POV)

- Type `/setup` or `/config` inside the TUI.
- Run `seri config set|list|unset` in a terminal (exception path).

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); use only non-secret keys (`SERI_MODEL`) in scripted drives — never write a real API key into a throwaway profile's config.

- **Set.** Run `bun apps/cli/src/cli.ts --profile verify-<run-id> config set SERI_MODEL openai/gpt-oss-20b; $LASTEXITCODE`. Prints `Saved SERI_MODEL to <profile>\config.json`, exit 0.
- **List (masked).** Run `... config list`. Shows `SERI_MODEL = open...-20b` — first four and last four characters around `...`, never the full value.
- **Env shadowing.** Run `$env:SERI_MODEL = "other/model"; ... config list; Remove-Item Env:SERI_MODEL`. The line ends with `(overridden by env var)`.
- **Unset.** Run `... config unset SERI_MODEL` (prints `Removed SERI_MODEL`), then `... config list` again — `No values set in <profile>\config.json`.
- **Proof.** All four command outputs with exit codes; the set→list→unset→list sequence is the mutation plus its read-back.

## Gotchas

- `list` masks values — asserting on a full value fails on a healthy build; assert on the key name and the mask shape.
- Env always wins over config.json; a leftover `SERI_MODEL`/`SERI_PROVIDER` in the driving shell silently changes what any later TUI drive runs against. Clear them before driving.
- `/setup`'s key probe rejects only on 401/403; an unreachable provider stores the key with a warning — a stored key is not proof the key works.
- config.json is written owner-only via write-then-rename; a missing file after a failed set means the rename never happened, not partial content.
