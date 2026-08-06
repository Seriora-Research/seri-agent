# SubagentStop hook (PowerShell variant) - appends to THIS session's trajectory.md.
# See log-trajectory.sh for the full rationale. Two defects fixed here on 2026-08-06:
#   1. WRONG FILE - `Get-ChildItem -Recurse | Select-Object -First 1` returned whichever
#      loop the filesystem yielded first, not the one this session is running.
#   2. NOTHING TO SAY - it read $env:CLAUDE_SUBAGENT_NAME / $env:CLAUDE_SUBAGENT_STATUS,
#      neither of which exists. Hook input arrives as JSON on stdin; the real fields are
#      `agent_type` and `agent_id`.

$payload = [Console]::In.ReadToEnd()
$sid = $null; $agent = $null; $agentId = $null
try {
  $json    = $payload | ConvertFrom-Json
  $sid     = $json.session_id
  $agent   = $json.agent_type
  $agentId = $json.agent_id
} catch {}

# --- Resolve THIS session's loop, never "the first one on disk" ---
$traj = $null
if ($sid) {
  foreach ($s in Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "SESSION" `
      -File -ErrorAction SilentlyContinue) {
    if ((Get-Content $s.FullName -Raw).Trim() -eq $sid) {
      $candidate = Join-Path $s.DirectoryName "trajectory.md"
      if (Test-Path $candidate) { $traj = $candidate }
      break
    }
  }
}

# Backward compatibility until every loop writes SESSION - but only when unambiguous.
# -Depth 1 keeps archived loops under .claude/loops/_archive/<slug>/ out of the count.
# If two loops are live and neither declared a session, write nothing: guessing silently
# corrupts another run's audit log, which is the defect this rewrite exists to remove.
if (-not $traj) {
  $all = @(Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "trajectory.md" `
    -File -ErrorAction SilentlyContinue)
  if ($all.Count -eq 1) { $traj = $all[0].FullName } else { exit 0 }
}

if (-not $traj) { exit 0 }
if (-not $agent) { $agent = "unknown-agent" }
$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$lines = "`n### $ts - subagent: $agent"
if ($agentId) { $lines += "`n- Agent id: $agentId" }
$lines += "`n- Summary: (see subagent return value in main context)"

Add-Content -Path $traj -Value $lines -Encoding utf8
exit 0
