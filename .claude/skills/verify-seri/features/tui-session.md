# Interactive TUI session

On a real terminal `seri` opens a full-screen (alternate-buffer) TUI: a welcome splash, then an input box for tasks and slash commands. The session never exits on its own; `/exit` (exact match) or Ctrl-D at the input box quits gracefully with the same token/cost summary the non-interactive path prints.

## Sub-features

- `tui-mount` splash renders, Escape dismisses it, the input box (`┌` border) and mode label render.
- `tui-turn` a typed task runs a real model turn; `done ·` marks completion and the TUI returns to awaiting input.
- `tui-exit` `/exit` + Enter and Ctrl-D both unmount, restore the main screen buffer, and print the accumulated usage summary (exit 0 when nothing was cut short).
- `tui-exit-guard` `/exit trailing words` shows a command error instead of quitting.

## How to get to it (user POV)

- Run `seri` (no task) in a real terminal — empty input box.
- Run `seri "<task>"` in a real terminal — TUI with the task submitted.
- Type into the input box; Enter submits; slash commands (`/mode`, `/model`, `/exit`, …) run in place.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README). Windows only as written (the helper uses node-pty/ConPTY, prebuilt for win32/darwin; POSIX runs live on the WSL box). helper runs under **node**.

- **Mount and quit.** Run `node .claude/skills/verify-seri/scripts/drive-tui.mjs .claude/loops/verify-seri/<run-id>/tui.txt verify-<run-id> "wait=Esc continue" sleep=400 key=esc sleep=600 type=/exit sleep=400 key=enter sleep=800`. Stderr says `DRIVE-RESULT code=0`; `tui.txt` contains the splash (`SERI`, `Esc continue`), `Session ` … ` created.`, and ends in reset escapes (the TUI unmounted).
- **Run a turn.** Same helper with steps `"wait=Esc continue" sleep=400 key=esc sleep=600 "type=Reply with exactly the word SERI-TUI-PROOF" "wait=exactly the word" key=enter "wait=done ·@90000" key=ctrl-d sleep=800`. Transcript shows the model line (`openai/gpt-oss-120b · your key`), the reply, and `done · <n> ↑, <n> ↓`.
- **Proof.** The helper's transcript file plus its `DRIVE-RESULT` line; record the full helper command beside them. Read the transcript in a separate shell command — stdout after the helper in the same command is unreliable.

## Gotchas

- The splash on an unauthenticated profile is a login picker — Enter SELECTS the highlighted `Log in` and starts a real WorkOS device flow (can open a browser). Dismiss with `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=600`; the Esc needs the settle, a too-early Esc is swallowed.
- The footer mode label (`⏸ approve-each mode on`) renders behind the splash — it is never proof the splash was dismissed.
- Waiting on the echo of typed text only works for a mid-text fragment of a longer string; slash commands and short strings get split by cursor redraw (`/ exit` in the stream) and never match — use `type=… sleep=400 key=enter`.
- Dismissing the splash does not mean the session is ready. Until it is, the app renders a `starting session…` placeholder that accepts no input, so a task typed there is not echoed and never runs. Wait for `created.` before typing. Issue #211 was this window read as a hang, widened by the models.dev fetch on the way to the first mount.
- The box borders are `┌`, never `╭` — asserting the wrong glyph family passes on nothing.
- Ctrl-C between turns is immediately fatal (the cancel slot only exists while a turn runs) — quit with `/exit` or Ctrl-D, not Ctrl-C.
- ConPTY re-serializes output; assert on text markers, not raw byte layout. The post-quit `(tokens: …)` summary may flush after capture ends — assert `done ·` instead.
- The helper must run under **node**; hosted by bun, every ConPTY child on this machine dies instantly with exit `-1073741510` (STATUS_CONTROL_C_EXIT), verified with a bare `cmd /c echo` probe. (The repo's own `tuiPtyWindows.test.ts` runs node-pty under `bun test` — expect the same failure there.)
- From Git Bash, set `MSYS_NO_PATHCONV=1` or `/exit` arrives as `C:/Program Files/Git/exit`.
