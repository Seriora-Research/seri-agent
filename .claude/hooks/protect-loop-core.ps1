# PreToolUse hook (PowerShell variant) for Write|Edit — freezes the loop's own
# governing files (hooks, settings, agent/skill definitions, templates) while
# a loop is active. See protect-loop-core.sh for the full rationale.

$payload = [Console]::In.ReadToEnd()
$file = $null
try {
  $json = $payload | ConvertFrom-Json
  $file = $json.tool_input.file_path
} catch {}
if (-not $file) { exit 0 }

$stateFile = Get-ChildItem -Path ".claude/loops" -Recurse -Filter "STATE.md" `
  -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $stateFile) { exit 0 }

$norm = $file -replace '\\', '/'
if ($norm -match '\.claude/hooks/|\.claude/settings\.json$|\.claude/agents/|\.claude/skills/|\.claude/templates/') {
  Write-Error "BLOCKED: $file defines loop enforcement/behavior and cannot be edited while a loop is active ($($stateFile.FullName)). Propose changes via the retro subagent into .claude/lessons/proposed/, or edit it outside any active loop."
  exit 2
}

exit 0
