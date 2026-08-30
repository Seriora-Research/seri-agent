# Sessions

Every TUI run is a session persisted as a row in the profile's SQLite database, `~\.seri\<profile>\seri.db`. `seri --continue` reopens the most recent session, `seri --resume <id>` a specific one, and `/clear` inside the TUI starts a new session while leaving the previous one resumable.

## Sub-features

- `session-persist` a completed session leaves a row in the `sessions` table of `~\.seri\<profile>\seri.db`.
- `session-continue` `seri --continue` reopens the most recent session with its transcript context.
- `session-resume` `seri --resume <id>` reopens that specific session.
- `session-clear` `/clear` starts a fresh session; the old one stays in the database and resumable.

## How to get to it (user POV)

- Run `seri --continue` or `seri --resume <id>` in a terminal.
- Type `/clear` inside the TUI.

## Driving it with the verify-seri harness

Preconditions:

- Baseline (see README); the throwaway profile has no sessions yet (`~\.seri\verify-<run-id>\seri.db` absent). There is no `sessions\` directory to check — see Gotchas.

- **Create a session.** Helper steps: `"wait=Esc continue" sleep=400 key=esc "wait=created.@30000" sleep=800 "type=Please remember the token SERI-SESSION-<run-id> for later and reply with just OK." "wait=for later and reply" key=enter "wait=done ·@90000" sleep=600 type=/exit sleep=400 key=enter sleep=900`. The mount banner `Session <id> created.` names the new session.
- **Session on disk.** Read the `sessions` table out of the database — there are no per-session files to list:

  ```
  bun -e "
  import { Database } from 'bun:sqlite';
  import { homedir } from 'node:os';
  import { join } from 'node:path';
  const db = new Database(join(homedir(), '.seri', 'verify-<run-id>', 'seri.db'), { readonly: true });
  console.log(db.query('SELECT id, updated_at_ms FROM sessions ORDER BY updated_at_ms DESC').all());
  "
  ```

  At least one row comes back; record the newest `id` for the resume drive.
- **Continue.** Run the helper again with CLI args: `drive-tui.mjs <out2> verify-<run-id> --continue :: "wait=Esc continue" sleep=400 key=esc sleep=1500 "type=What token did I ask you to remember earlier? Reply with it and nothing else." "wait=to remember earlier" key=enter "wait=SERI-SESSION-<run-id>@90000" sleep=600 type=/exit sleep=400 key=enter sleep=900`. The model can only know the token if the prior session's context actually loaded.
- **Resume by id.** Same drive with `--resume <id>` (the id recorded above) in place of `--continue`; same token assertion.
- **Clear.** Append to a resumed drive: `"type=/clear" sleep=500 key=enter "wait=The previous session is saved@20000" sleep=800`. The full line reads `Started a new session <new id>. The previous session is saved — resume it with: seri --resume <old id>`, which is both halves of the claim in one string. Anchor mid-message, not on `Started`: redraw drops the leading character of that line often enough to matter (`tarteda new session …` in a real capture).
- **Proof.** All transcripts (the token appears in the second and third without being re-stated by the drive's own typing — the `wait=` matches the model's reply because the typed question omits the token), plus the `sessions` table query above before and after.

## Gotchas

- **Sessions are in SQLite, not files.** `~\.seri\<profile>\seri.db` holds them in a `sessions` table; a fresh profile has no `sessions\` directory at all and never grows one. A `sessions\` path is read exactly once, on startup, to import legacy `.jsonl` files from an older seri — a listing of it proves nothing about the current run. Verified on a fresh throwaway profile: after a first turn the profile root held `checkpoints` and `seri.db`, nothing else.
- `/clear` prints `Started a new session …`, not `Session <id> created.` — the `created.` banner belongs to a process mount. Waiting on `created.` after `/clear` times out.
- The second drive's question must not contain the token itself, or the `wait=` match proves nothing — it would match the echo of your own input.
- The echo-wait after `type=` must be a **mid-text** fragment. `"wait=Remember this"` against a task starting with "Remember this token:" does not match — cursor redraw splits the head of a line in the byte stream. Anchor on something several words in.
- `--continue` picks the most recent session in the profile; a stray extra session from a failed earlier attempt changes which one loads. A drive that dies before its turn still leaves an empty session row that `--continue` will then pick. Clean up failed attempts before re-driving, or resume by explicit id.
- A resumed drive needs a longer settle after the splash Esc (`sleep=1500`) before typing: `--continue`/`--resume` suppress the `created.` banner, so there is no wait to anchor readiness on.
- `/clear` keeps the process running in a new session — it is not an exit; the old session id stays valid for `--resume`.
