# PreToolUse hook (PowerShell variant) for Skill — blocks dispatch of the mode
# planner skill (feature-plan / bugfix-report / research-spec) until STATE.md
# has a `## Goal Audit` block with a non-empty success_check line.
#
# Claude Code delivers hook input as a JSON object on stdin (not env vars):
#   {"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"...","args":"..."}}

$payload = [Console]::In.ReadToEnd()
$skill = $null
try {
  $json = $payload | ConvertFrom-Json
  $skill = $json.tool_input.skill
} catch {}

if ($skill -ne "feature-plan" -and $skill -ne "bugfix-report" -and $skill -ne "research-spec") {
  exit 0
}

$stateFile = Get-ChildItem -Path ".claude/loops" -Recurse -Filter "STATE.md" `
  -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $stateFile) {
  Write-Error "BLOCKED: no active STATE.md — run the engineering-loop Goal Audit step first"
  exit 2
}

$stateContent = Get-Content $stateFile.FullName -Raw

if ($stateContent -notmatch '(?m)^## Goal Audit') {
  Write-Error "BLOCKED: STATE.md has no '## Goal Audit' block — invoke challenge-the-goal before planning"
  exit 2
}

$successMatch = [regex]::Match($stateContent, '(?m)^- success_check:\s*(.*)$')
$successCheck = if ($successMatch.Success) { $successMatch.Groups[1].Value.Trim() } else { "" }
if ([string]::IsNullOrWhiteSpace($successCheck)) {
  Write-Error "BLOCKED: Goal Audit success_check is empty — restate a verifiable success check before planning"
  exit 2
}

exit 0
