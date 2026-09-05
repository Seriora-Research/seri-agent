# Config and API keys

Per-profile settings and BYOK API keys live in `~\.seri\<profile>\config.json`. The TUI paths are `/setup` (provider keys) and `/config` (non-provider settings), and they are the only paths: there is no `config` subcommand, and no `configCommand` function anywhere in the source — `apps/cli/src/config/commands.ts` defines only the `maskValue` helper. `run()` special-cases the positional verbs `serve`, `exec`, `doctor`, and `update`; `seri config list` is none of those, so it reaches the model as a task and bills a turn.

## Sub-features

- `config-set` `/config` writes a key to the profile's config.json. A boolean row toggles in place on Enter/`a`; a string row opens a separate entry step that saves on its own Enter.
- `config-list` `/config` lists the three known keys plus any other non-provider key already in config.json.
- `config-unset` `r`/Delete on a removable row opens a `? [y]es / [N]o` confirm; only `y` removes it.
- `config-env-shadow` the list flags a key whose value an environment variable currently overrides (env beats config.json).
- `config-tui-setup` `/setup` in the TUI adds/replaces/removes a provider key, probing it with one lightweight request.

## How to get to it (user POV)

- Type `/setup` or `/config` inside the TUI. That is the only path.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); drive only non-secret keys — never write a real API key into a throwaway profile's config. `SERI_REASONING_EFFORT` is the safe target: it is always present in the panel and it takes effect immediately, so no `(takes effect on the next run)` suffix muddies the confirmation line.

- **Set a value and read it back.** Helper steps: `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=800 "type=/config" sleep=500 key=enter "wait=Reasoning effort@15000" sleep=600 key=down key=down sleep=400 key=enter "wait=Set Reasoning effort@15000" sleep=500 "type=high" sleep=400 key=enter "wait=Saved SERI_REASONING_EFFORT.@15000" sleep=800 key=esc sleep=500 "type=/config" sleep=500 key=enter "wait=Reasoning effort: high (config)@15000" sleep=600 key=esc sleep=500 type=/exit sleep=400 key=enter sleep=900`.

  Two downs reach `SERI_REASONING_EFFORT`: the panel's fixed order is `SERI_VERIFY_ENABLED`, `SERI_VERIFY_COMMAND`, `SERI_REASONING_EFFORT`. Enter on that string row opens `Set Reasoning effort (SERI_REASONING_EFFORT)`; the value is typed there and submitted with its own Enter.
- **Second, read-only view.** The reopened panel row reads `Reasoning effort: high (config)` — the source tag names where the value came from. Cross-check on disk: `~\.seri\verify-<run-id>\config.json` contains `"SERI_REASONING_EFFORT": "high"`.
- **Proof.** The transcript (the entry step opening, `Saved SERI_REASONING_EFFORT.`, the reopened row), plus the config.json read.
- **Not yet written.** `/setup`'s provider-key flow and `config-env-shadow` have no drive. `/setup` needs a key to probe, which a throwaway profile has no safe way to supply; the env-shadow row needs a drive launched with the variable set. Add both with `/pstack:maintain-verification-skill`.

## Gotchas

- **Only unknown keys are masked.** Masking applies to keys the panel does not know about (`secret = !CONFIG_KEY_INFO.has(key)`), i.e. hand-added ones. The three known keys render raw: `SERI_VERIFY_COMMAND` and `SERI_REASONING_EFFORT` show their real value, `SERI_VERIFY_ENABLED` shows `on`/`off`. A drive asserting a mask shape against one of those three fails on a healthy build.
- Writing a value is two steps, not one, for a string key: Enter opens the entry step, and a second Enter inside it saves. A drive that sends one Enter and then waits for `Saved …` hangs. A boolean key is the opposite — Enter writes it immediately, with no entry step to wait for.
- Unsetting always goes through the `? [y]es / [N]o` confirm; the answer is a single keypress, no Enter.
- Env always wins over config.json; a leftover `SERI_MODEL`/`SERI_PROVIDER` in the driving shell silently changes what any later TUI drive runs against. Clear them before driving.
- `/setup`'s key probe rejects only on 401/403; an unreachable provider stores the key with a warning — a stored key is not proof the key works.
- config.json is written owner-only via write-then-rename; a missing file after a failed set means the rename never happened, not partial content.
