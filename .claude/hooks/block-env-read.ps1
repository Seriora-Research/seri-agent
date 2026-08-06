# PreToolUse hook for Read (PowerShell variant) — blocks access to .env files.
$file = $env:CLAUDE_TOOL_INPUT_FILE_PATH
if (-not $file) { exit 0 }

if ($file -match '(^|[/\\])\.env([^a-zA-Z/\\]|$)') {
  Write-Error "BLOCKED: .env file access via Read tool"
  exit 2
}

exit 0
