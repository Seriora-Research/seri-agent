# SubagentStop hook (PowerShell variant) — appends to the active trajectory.md.
$traj = Get-ChildItem -Path ".claude/loops" -Recurse -Filter "trajectory.md" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $traj) { exit 0 }

$agent  = if ($env:CLAUDE_SUBAGENT_NAME)   { $env:CLAUDE_SUBAGENT_NAME }   else { "unknown-agent" }
$status = if ($env:CLAUDE_SUBAGENT_STATUS) { $env:CLAUDE_SUBAGENT_STATUS } else { "unknown" }
$ts     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

@"

### $ts — subagent: $agent
- Status: $status
- Summary: (see subagent return value in main context)
"@ | Add-Content -Path $traj.FullName -Encoding utf8

exit 0
