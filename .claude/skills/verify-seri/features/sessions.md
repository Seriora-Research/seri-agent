# Sessions

Every TUI run is a session persisted under the profile's `sessions/` directory. `seri --continue` reopens the most recent session, `seri --resume <id>` a specific one, and `/clear` inside the TUI starts a new session while leaving the previous one resumable.

## Sub-features

- `session-persist` a completed session leaves an entry under `~\.seri\<profile>\sessions\`.
- `session-continue` `seri --continue` reopens the most recent session with its transcript context.
- `session-resume` `seri --resume <id>` reopens that specific session.
- `session-clear` `/clear` starts a fresh session; the old one stays on disk and resumable.

## How to get to it (user POV)

- Run `seri --continue` or `seri --resume <id>` in a terminal.
- Type `/clear` inside the TUI.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); the throwaway profile has no sessions yet (`~\.seri\verify-<run-id>\sessions\` absent or empty).

- **Create a session.** Helper steps: `"wait=Esc continue" sleep=400 key=esc sleep=600 "type=Remember this token: SERI-SESSION-<run-id>. Reply OK." "wait=Remember this" key=enter "wait=done ·@90000" type=/exit sleep=400 key=enter sleep=800`. The mount banner `Session <id> created.` names the new session.
- **Session on disk.** `Get-ChildItem ~\.seri\verify-<run-id>\sessions\` lists at least one entry; record its id.
- **Continue.** Run the helper again with CLI args: `drive-tui.mjs <out2> verify-<run-id> --continue :: "wait=Esc continue" sleep=400 key=esc sleep=600 "type=What token did I ask you to remember? Reply with it exactly." "wait=ask you to remember" key=enter "wait=SERI-SESSION-<run-id>@90000" type=/exit sleep=400 key=enter sleep=800`. The model can only know the token if the prior session's context actually loaded.
- **Resume by id.** Same drive with `--resume <id>` (the id recorded above) in place of `--continue`; same token assertion.
- **Proof.** Both transcripts (the token appears in the second without being re-stated by the drive's own typing — note the `wait=` matches the model's reply because the typed question omits the token), plus the sessions directory listing.

## Gotchas

- The second drive's question must not contain the token itself, or the `wait=` match proves nothing — it would match the echo of your own input.
- `--continue` picks the most recent session in the profile; a stray extra session from a failed earlier attempt changes which one loads. Clean up failed attempts before re-driving.
- `/clear` keeps the process running in a new session — it is not an exit; the old session id stays valid for `--resume`.
