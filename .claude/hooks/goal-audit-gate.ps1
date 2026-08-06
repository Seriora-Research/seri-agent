# PreToolUse hook (PowerShell variant) for Skill - blocks dispatch of the mode
# planner skill (feature-plan / bugfix-report / research-spec) until STATE.md
# has a `## Goal Audit` block with a non-empty success_check line.
#
# Claude Code delivers hook input as a JSON object on stdin (not env vars):
#   {"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"...","args":"..."}}

#
# CHANGED 2026-08-06: this gate used to take the first STATE.md the filesystem yielded,
# which is not the loop this session is running - it was validating a finished run's Goal
# Audit and passing. A gate that reads the wrong file reports green identically to one
# that works. It now resolves the loop from this session's own `session_id`.

$payload = [Console]::In.ReadToEnd()
$skill = $null; $sid = $null
try {
  $json  = $payload | ConvertFrom-Json
  $skill = $json.tool_input.skill
  $sid   = $json.session_id
} catch {}

if ($skill -ne "feature-plan" -and $skill -ne "bugfix-report" -and $skill -ne "research-spec") {
  exit 0
}

# --- Resolve THIS session's loop ---
$statePath = $null
if ($sid) {
  foreach ($s in Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "SESSION" `
      -File -ErrorAction SilentlyContinue) {
    if ((Get-Content $s.FullName -Raw).Trim() -eq $sid) {
      $statePath = Join-Path $s.DirectoryName "STATE.md"
      break
    }
  }
}

# Backward compatibility until every loop writes SESSION. -Depth 1 excludes archived loops.
if (-not $statePath) {
  $all = @(Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "STATE.md" `
    -File -ErrorAction SilentlyContinue)
  if ($all.Count -eq 1) {
    $statePath = $all[0].FullName
  } elseif ($all.Count -gt 1) {
    # Ambiguous, and this gate fails CLOSED: guessing could green-light planning against
    # another run's audit block, which is the defect this rewrite exists to remove.
    Write-Error "BLOCKED: $($all.Count) active loops and no SESSION file identifies this one - write the session id to .claude/loops/<slug>/SESSION at INIT"
    exit 2
  }
}

if (-not $statePath -or -not (Test-Path $statePath)) {
  Write-Error "BLOCKED: no active STATE.md - run the engineering-loop Goal Audit step first"
  exit 2
}

$stateContent = Get-Content $statePath -Raw

if ($stateContent -notmatch '(?m)^## Goal Audit') {
  Write-Error "BLOCKED: $statePath has no '## Goal Audit' block - invoke challenge-the-goal before planning"
  exit 2
}

$successMatch = [regex]::Match($stateContent, '(?m)^- success_check:\s*(.*)$')
$successCheck = if ($successMatch.Success) { $successMatch.Groups[1].Value.Trim() } else { "" }
if ([string]::IsNullOrWhiteSpace($successCheck)) {
  Write-Error "BLOCKED: $statePath's Goal Audit success_check is empty - restate a verifiable success check before planning"
  exit 2
}

exit 0
