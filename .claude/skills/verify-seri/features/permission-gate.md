# Permission gate

Every write-capable tool call passes a gate with three modes — `read-only`, `approve-each` (the default for a new session), `auto` — cycled from the TUI. In `approve-each` the ApprovalBox interrupts the turn and the user answers with one keypress; `always` answers persist per project for `write_file`/`edit`.

## Sub-features

- `gate-mode-cycle` Shift+Tab (or `/mode`) cycles the mode; the footer label changes accordingly.
- `gate-approve-once` `y` at the ApprovalBox runs the tool this once.
- `gate-deny` `n` (or just Enter — No is the default) declines the tool; three consecutive denials end the run early.
- `gate-always` `a` persists the grant for this project (`write_file`/`edit` only) and later calls skip the prompt.
- `gate-read-only` in `read-only` mode writes are blocked outright, with no prompt.
- `gate-shell-no-always` `bash`/`powershell` prompts never offer `[a]lways`.

## How to get to it (user POV)

- Press Shift+Tab in the TUI, or type `/mode`, to cycle the permission mode.
- Submit a task that writes a file; the ApprovalBox appears with `[y]es / [a]lways (saved for this project) / [N]o`.
- Review and revoke persisted grants with `/permissions` in the TUI. There is no `seri permissions` subcommand; that first word reaches the model as a task.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); a scratch file name unused at the repo root, e.g. `gate-probe-<run-id>.txt`.

- **Mode cycling.** Run the helper with steps `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=800 key=shift-tab "wait=bypass permissions on@10000" sleep=400 key=shift-tab "wait=read-only mode on@10000" sleep=400 key=shift-tab "wait=approve-each mode on@10000"`. The label walks `⏸ approve-each mode on` → `⏵⏵ bypass permissions on` → `⏸ read-only mode on` and back, which proves the cycle order rather than one hop of it.
- **Prompt and approve.** Steps: `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=800 "type=Create a file named gate-probe-<run-id>.txt containing exactly GATE-OK" "wait=containing exactly" key=enter "wait=[y]es@90000" type=y "wait=done ·@90000" type=/exit sleep=400 key=enter sleep=800`. The ApprovalBox names `write_file` and the file path; after `y` the turn completes.
- **Side effect.** `Get-Content gate-probe-<run-id>.txt` contains `GATE-OK`; the profile's `permissions.yaml` shows no grant (a `y` is once, not always).
- **Persisted grant.** Repeat the drive answering `type=a` instead; the profile's `permissions.yaml` afterwards carries `write_file`. Revoking through `/permissions` is a TUI drive that has not been written yet — add it with `/pstack:maintain-verification-skill`.
- **Proof.** The transcript (prompt text visible, answer keypress, `done ·`), the probe file's content, and the before/after contents of the profile's `permissions.yaml`.

## Gotchas

- ApprovalBox answers are single keypresses — `type=y`, never `type=y key=enter`; a stray Enter after is a submit into the next input box.
- The prompt renders `[N]o` capitalized because No is the default; any other key is not a silent deny — only the documented keys act.
- Grants (run-scoped and persisted) do not survive cycling into `read-only`.
- The mode cycle order matters for scripted drives: from a fresh session one Shift+Tab lands on `bypass permissions on`; wait for the label text, don't count presses.
- Answering `n` three times in a row ends the run (`repeated-denials`) — a drive that means to test denial once must not queue extra `n`s.
- `--permission-prompts none` is a real product flag but a run using it proves nothing about the ApprovalBox.
