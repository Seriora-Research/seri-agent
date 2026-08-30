# Config and API keys

Per-profile settings and BYOK API keys live in `~\.seri\<profile>\config.json`. The TUI paths are `/setup` (provider keys) and `/config` (non-provider settings); the `seri config set|list|unset` subcommand is **gone**: `configCommand` (`apps/cli/src/config/commands.ts`) has no dispatch site left in `run()`, only its `maskValue` helper is still imported, and `seri --help` does not list it. Running `seri config list` sends `config list` to the model as a task and bills a turn.

## Sub-features

- `config-set` `/config` writes a key to the profile's config.json.
- `config-list` `/config` lists every key with the value masked.
- `config-unset` `/config` removes a key.
- `config-env-shadow` the list flags a key whose value an environment variable currently overrides (env beats config.json).
- `config-tui-setup` `/setup` in the TUI adds/replaces/removes a provider key, probing it with one lightweight request.

## How to get to it (user POV)

- Type `/setup` or `/config` inside the TUI. That is the only path.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); use only non-secret keys (`SERI_MODEL`) in scripted drives — never write a real API key into a throwaway profile's config.

**These four steps are broken and must not be run.** They drive a `config` subcommand that no longer exists, so each one bills a model turn and proves nothing. The replacement drives the `/config` panel in the TUI and has not been written or run yet; write it with `/pstack:maintain-verification-skill` rather than guessing at it here. The masking, env-shadowing and write-then-rename behaviour below is still accurate about the app, only the way to reach it changed.

## Gotchas

- `list` masks values — asserting on a full value fails on a healthy build; assert on the key name and the mask shape.
- Env always wins over config.json; a leftover `SERI_MODEL`/`SERI_PROVIDER` in the driving shell silently changes what any later TUI drive runs against. Clear them before driving.
- `/setup`'s key probe rejects only on 401/403; an unreachable provider stores the key with a warning — a stored key is not proof the key works.
- config.json is written owner-only via write-then-rename; a missing file after a failed set means the rename never happened, not partial content.
