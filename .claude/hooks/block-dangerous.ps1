# PreToolUse hook (PowerShell variant) - blocks destructive commands.
$cmd = $env:CLAUDE_TOOL_INPUT_COMMAND
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
