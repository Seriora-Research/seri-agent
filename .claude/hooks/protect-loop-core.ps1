# PreToolUse hook (PowerShell variant) for Write|Edit - freezes the loop's own
# governing files (hooks, settings, agent/skill definitions, templates) while
# a loop is active. See protect-loop-core.sh for the full rationale.

$payload = [Console]::In.ReadToEnd()
$file = $null
try {
  $json = $payload | ConvertFrom-Json
  $file = $json.tool_input.file_path
} catch {}
if (-not $file) { exit 0 }

# Only guard while a loop is actually running. This is a GLOBAL freeze, so it deliberately
# does not resolve "which loop is mine" - but it does need a truthful liveness signal:
# -Depth 1 excludes archived runs, and the Status check excludes a finished-but-not-yet-
# archived one. See protect-loop-core.sh. Fails closed: an unreadable Status counts as live.
$active = $null
foreach ($s in Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "STATE.md" `
    -File -ErrorAction SilentlyContinue) {
  $m = [regex]::Match((Get-Content $s.FullName -Raw), '(?m)^- Status:\s*(\S+)')
  $st = if ($m.Success) { $m.Groups[1].Value } else { "" }
  if ($st -eq "DONE" -or $st -eq "BLOCKED") { continue }
  $active = $s.FullName
  break
}
if (-not $active) { exit 0 }

$norm = $file -replace '\\', '/'
if ($norm -match '\.claude/hooks/|\.claude/settings\.json$|\.claude/agents/|\.claude/skills/|\.claude/templates/') {
  Write-Error "BLOCKED: $file defines loop enforcement/behavior and cannot be edited while a loop is active ($active). Propose changes via the retro subagent into .claude/lessons/proposed/, or edit it outside any active loop."
  exit 2
}

exit 0
