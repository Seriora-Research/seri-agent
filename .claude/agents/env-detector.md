---
name: env-detector
description: One-shot environment probe. Detects OS, shell, WSL status, package managers, runtimes, and tool availability and writes environment.md. Run once at INIT before any other agent.
tools: Bash, Read
model: inherit
---

Probe the execution environment and write a complete `.claude/loops/<slug>/environment.md`
using `.claude/templates/environment.md` as the template. Fill every section — do not leave
placeholders. Adapt probe commands to what you discover as you go.

Detection steps (run the checks, then write the file):

1. **OS / kernel**
   - Try `uname -a` (present on Linux, macOS, WSL; absent on native Windows PowerShell).
   - If absent, run `pwsh -Command "[System.Environment]::OSVersion"`.
   - Check `/proc/version` for "Microsoft" → WSL. Run `wsl.exe --version` to
     distinguish WSL1 vs WSL2.

2. **Shell**
   - `echo $SHELL` (bash/zsh/fish on POSIX); `$env:ComSpec` + `$PSVersionTable` on Windows.
   - Note the shell Claude Code / the runner is actually invoking right now.

3. **Package managers** — test `which` / `Get-Command` for each:
   `npm`, `pnpm`, `yarn`, `bun`, `pip`, `pip3`, `uv`, `poetry`, `cargo`, `go`,
   `brew`, `winget`, `choco`, `scoop`, `apt`, `dnf`, `pacman`.
   Record name + version for each found.

4. **Language runtimes** — probe: `node -v`, `python3 --version`, `python --version`,
   `go version`, `rustc --version`, `java -version`, `ruby --version`, `php --version`.
   Record found ones only.

5. **Key tools** — `git --version`, `docker --version`, `podman --version`,
   `curl --version`, `jq --version`, `make --version`. Note absent ones.

6. **Path conventions**
   - Drive-letter paths (`C:\`) → native Windows.
   - `/mnt/c/` mounts → WSL.
   - `/home/` → Linux / macOS.
   - Record home directory and project root as absolute paths.

7. **Hook compatibility note** — state the shell invocation for hooks:
   - `bash` on Linux / macOS / WSL.
   - `pwsh -NonInteractive -File` on native Windows.
   - If bash is available via Git Bash on Windows, note the path.
   This is the value the orchestrator reads to adapt all hook commands.

Write the result to `.claude/loops/<slug>/environment.md` and return the path.
