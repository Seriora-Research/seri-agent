# beforeShellExecution / preToolUse Shell - blocks destructive commands.
$payload = [Console]::In.ReadToEnd()
$cmd = $env:CLAUDE_TOOL_INPUT_COMMAND
if (-not $cmd) {
  try { $cmd = ($payload | ConvertFrom-Json).command } catch {}
}
if (-not $cmd) {
  try { $cmd = ($payload | ConvertFrom-Json).tool_input.command } catch {}
}
if (-not $cmd) { exit 0 }

$blocked = @(
  "rm -rf /",
  "rm -rf ~",
  "Remove-Item -Recurse -Force C:\\",
  "git push --force.*main",
  "git push --force.*master",
  "git push -f.*main",
  "git push -f.*master",
  "git reset --hard",
  "Format-Volume",
  "Clear-Disk"
)

foreach ($pattern in $blocked) {
  if ($cmd -match $pattern) {
    Write-Error "BLOCKED: dangerous command pattern detected: $pattern"
    exit 2
  }
}

if ($cmd -match '\.env[^a-zA-Z]|\.env$') {
  Write-Error "BLOCKED: .env file access"
  exit 2
}

exit 0
