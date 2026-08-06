# Environment — <slug>
Detected: <iso8601>

## OS & kernel
- Platform: <Linux | macOS | Windows | WSL1 | WSL2>
- Version: <uname -a output or Windows OS version string>
- WSL distro: <distro name + version, or N/A>

## Shell
- Default shell: <bash | zsh | fish | pwsh | cmd>
- Shell version: <version string>
- Claude Code invoking via: <bash | pwsh>  ← orchestrator reads this for hook commands

## Package managers (found only)
| tool | version |
|------|---------|
|      |         |

## Language runtimes (found only)
| runtime | version |
|---------|---------|
|         |         |

## Key tools
| tool   | version | present |
|--------|---------|---------|
| git    |         | yes/no  |
| docker |         | yes/no  |
| curl   |         | yes/no  |
| jq     |         | yes/no  |
| make   |         | yes/no  |

## Path conventions
- Style: <POSIX `/home/user/` | Windows `C:\Users\` | WSL `/mnt/c/Users/`>
- Home: <absolute path>
- Project root: <absolute path>
- Line endings: <LF | CRLF>

## Hook compatibility
- Shell invocation for hooks: `<bash .claude/hooks/foo.sh | pwsh -NonInteractive -File .claude/hooks/foo.ps1>`
- Notes: <any caveats, e.g. "bash available via Git Bash at C:\Program Files\Git\bin\bash.exe">
