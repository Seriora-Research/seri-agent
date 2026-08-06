# Stop hook (PowerShell variant) - exit 2 forces Claude to keep working.
# Guards against: firing outside EXECUTE/VERIFY, research mode, infinite retry.
#
# CHANGED 2026-08-06: both STATE.md and environment.md used to resolve to whichever loop
# the filesystem yielded first rather than this session's, so the gate read another run's
# Mode/Status and another machine's package manager. See verify-gate.sh.

$payload = [Console]::In.ReadToEnd()
$sid = $null
try { $sid = ($payload | ConvertFrom-Json).session_id } catch {}

# --- Resolve THIS session's loop ---
$loopDir = $null
if ($sid) {
  foreach ($s in Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "SESSION" `
      -File -ErrorAction SilentlyContinue) {
    if ((Get-Content $s.FullName -Raw).Trim() -eq $sid) { $loopDir = $s.DirectoryName; break }
  }
}

# Backward compatibility until every loop writes SESSION. -Depth 1 excludes archived loops.
# On ambiguity this gate exits 0 rather than guessing - the direction that matters here is
# never forcing a session to keep working against another run's state.
if (-not $loopDir) {
  $all = @(Get-ChildItem -Path ".claude/loops" -Depth 1 -Filter "STATE.md" `
    -File -ErrorAction SilentlyContinue)
  if ($all.Count -eq 1) { $loopDir = $all[0].DirectoryName } else { exit 0 }
}

# --- Guard: only run when an engineering-loop EXECUTE/VERIFY phase is active ---
$statePath = Join-Path $loopDir "STATE.md"
if (-not (Test-Path $statePath)) { exit 0 }

$stateContent = Get-Content $statePath -Raw
$modeMatch   = [regex]::Match($stateContent, '^- Mode:\s*(\S+)', 'Multiline')
$statusMatch = [regex]::Match($stateContent, '^- Status:\s*(\S+)', 'Multiline')
$mode   = if ($modeMatch.Success)   { $modeMatch.Groups[1].Value }   else { "" }
$status = if ($statusMatch.Success) { $statusMatch.Groups[1].Value } else { "" }

if ($mode -eq "research") { exit 0 }
if ($status -ne "EXECUTE" -and $status -ne "VERIFY") { exit 0 }

# --- Iteration ceiling ---
$failCountFile = Join-Path $loopDir ".gate-fail-count"
$maxFailures   = 5
$failCount     = 0
if (Test-Path $failCountFile) {
  $raw = (Get-Content $failCountFile -Raw).Trim()
  if ($raw -match '^\d+$') { $failCount = [int]$raw }
}

# --- Detect package manager from THIS loop's environment.md ---
$envFile = Join-Path $loopDir "environment.md"
$pkgMgr = "npm"
if (Test-Path $envFile) {
  $envContent = Get-Content $envFile -Raw
  if ($envContent -match "pnpm") { $pkgMgr = "pnpm" }
  if ($envContent -match "\bbun\b") { $pkgMgr = "bun" }
}

$fail     = $false
$gatesRan = $false

# --- JS/TS gates ---
if (Test-Path "package.json") {
  $gatesRan = $true
  & $pkgMgr run lint
  if ($LASTEXITCODE -ne 0) { Write-Error "LINT failed"; $fail = $true }

  & $pkgMgr run typecheck
  if ($LASTEXITCODE -ne 0) { Write-Error "TYPECHECK failed"; $fail = $true }

  & $pkgMgr test
  if ($LASTEXITCODE -ne 0) { Write-Error "TESTS failed"; $fail = $true }
}

# --- Python gate ---
$hasPyProject = (Test-Path "pyproject.toml") -or (Test-Path "setup.py") -or (Test-Path "setup.cfg")
if ((Get-Command pytest -ErrorAction SilentlyContinue) -and $hasPyProject) {
  $gatesRan = $true
  pytest -q
  if ($LASTEXITCODE -ne 0) { Write-Error "PYTEST failed"; $fail = $true }
}

if (-not $gatesRan) {
  Write-Warning "No recognised test stack found - skipping gate"
  exit 0
}

# --- Result ---
if (-not $fail) {
  if (Test-Path $failCountFile) { Remove-Item $failCountFile -Force }
  exit 0
}

$failCount++
Set-Content $failCountFile "$failCount"

if ($failCount -ge $maxFailures) {
  Write-Error "Gate failed $failCount consecutive times - marking BLOCKED and halting continuation."
  $updated = $stateContent -replace '(?m)^- Status: .*', '- Status: BLOCKED'
  Set-Content $statePath $updated
  if (Test-Path $failCountFile) { Remove-Item $failCountFile -Force }
  exit 0
}

exit 2
