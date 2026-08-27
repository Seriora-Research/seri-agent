# SubagentStop hook (PowerShell variant) - appends to THIS session's trajectory.md.
# See log-trajectory.sh for the full rationale. Defects fixed here:
#   1. WRONG FILE (2026-08-06) - `Get-ChildItem -Recurse | Select-Object -First 1` returned
#      whichever loop the filesystem yielded first, not the one this session is running.
#   2. NOTHING TO SAY (2026-08-06) - it read $env:CLAUDE_SUBAGENT_NAME /
#      $env:CLAUDE_SUBAGENT_STATUS, neither of which exists. Hook input arrives as JSON on
#      stdin; the real fields are `agent_type` and `agent_id`.
#   3. STILL MOSTLY NOISE (2026-08-13) - (2) only repaired named top-level `Agent`
#      dispatches. A dispatched agent's own internal work (nested Task calls, or
#      WebFetch/WebSearch-backed sub-steps it issues itself) fires its own SubagentStop
#      event with `agent_type` genuinely absent, not mis-parsed - measured 83-89% of all
#      subagent: rows across four loops. Skip the entry instead of writing
#      "unknown-agent"; retro's trigger table never keys on these rows.

$payload = [Console]::In.ReadToEnd()
$sid = $null; $agent = $null; $agentId = $null
try {
  $json    = $payload | ConvertFrom-Json
  $sid     = $json.session_id
  $agent   = $json.agent_type
  if (-not $agent) { $agent = $json.subagent_type }
  $agentId = $json.agent_id
  if (-not $agentId) { $agentId = $json.subagent_id }
} catch {}

# --- Resolve THIS session's loop, never "the first one on disk" ---
$traj = $null
if ($sid) {
  foreach ($s in Get-ChildItem -Path ".cursor/loops" -Depth 1 -Filter "SESSION" `
      -File -ErrorAction SilentlyContinue) {
    if ((Get-Content $s.FullName -Raw).Trim() -eq $sid) {
      $candidate = Join-Path $s.DirectoryName "trajectory.md"
      if (Test-Path $candidate) { $traj = $candidate }
      break
    }
  }
}

# Backward compatibility until every loop writes SESSION - but only when unambiguous.
# -Depth 1 keeps archived loops under .cursor/loops/_archive/<slug>/ out of the count.
# If two loops are live and neither declared a session, write nothing: guessing silently
# corrupts another run's audit log, which is the defect this rewrite exists to remove.
if (-not $traj) {
  $all = @(Get-ChildItem -Path ".cursor/loops" -Depth 1 -Filter "trajectory.md" `
    -File -ErrorAction SilentlyContinue)
  if ($all.Count -eq 1) { $traj = $all[0].FullName } else { exit 0 }
}

if (-not $traj) { exit 0 }
if (-not $agent) { exit 0 }
$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$lines = "`n### $ts - subagent: $agent"
if ($agentId) { $lines += "`n- Agent id: $agentId" }
$lines += "`n- Summary: (see subagent return value in main context)"

Add-Content -Path $traj -Value $lines -Encoding utf8
exit 0
