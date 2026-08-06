# Stop hook (PowerShell variant) — exit 2 forces Claude to keep working.
# Guards against: firing outside EXECUTE/VERIFY, research mode, infinite retry.

# --- Guard: only run when an engineering-loop EXECUTE/VERIFY phase is active ---
$stateFile = Get-ChildItem -Path ".claude/loops" -Recurse -Filter "STATE.md" `
  -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $stateFile) { exit 0 }

$stateContent = Get-Content $stateFile.FullName -Raw
$modeMatch   = [regex]::Match($stateContent, '^- Mode:\s*(\S+)', 'Multiline')
$statusMatch = [regex]::Match($stateContent, '^- Status:\s*(\S+)', 'Multiline')
$mode   = if ($modeMatch.Success)   { $modeMatch.Groups[1].Value }   else { "" }
$status = if ($statusMatch.Success) { $statusMatch.Groups[1].Value } else { "" }

if ($mode -eq "research") { exit 0 }
if ($status -ne "EXECUTE" -and $status -ne "VERIFY") { exit 0 }

# --- Iteration ceiling ---
$slugDir       = $stateFile.DirectoryName
$failCountFile = Join-Path $slugDir ".gate-fail-count"
$maxFailures   = 5
$failCount     = 0
if (Test-Path $failCountFile) {
  $raw = (Get-Content $failCountFile -Raw).Trim()
  if ($raw -match '^\d+$') { $failCount = [int]$raw }
}

# --- Detect package manager ---
$envFile = Get-ChildItem -Path ".claude/loops" -Recurse -Filter "environment.md" `
  -ErrorAction SilentlyContinue | Select-Object -First 1
$pkgMgr = "npm"
if ($envFile) {
  $envContent = Get-Content $envFile.FullName -Raw
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
  Write-Warning "No recognised test stack found — skipping gate"
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
  Write-Error "Gate failed $failCount consecutive times — marking BLOCKED and halting continuation."
  $updated = $stateContent -replace '(?m)^- Status: .*', '- Status: BLOCKED'
  Set-Content $stateFile.FullName $updated
  if (Test-Path $failCountFile) { Remove-Item $failCountFile -Force }
  exit 0
}

exit 2
