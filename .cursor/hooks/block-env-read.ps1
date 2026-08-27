# beforeReadFile / preToolUse Read - blocks access to .env files.
$payload = [Console]::In.ReadToEnd()
$file = $env:CLAUDE_TOOL_INPUT_FILE_PATH
if (-not $file) {
  try {
    $json = $payload | ConvertFrom-Json
    $file = $json.file_path
    if (-not $file) { $file = $json.path }
    if (-not $file) { $file = $json.tool_input.file_path }
    if (-not $file) { $file = $json.tool_input.path }
  } catch {}
}
if (-not $file) { exit 0 }

if ($file -match '(^|[/\\])\.env([^a-zA-Z/\\]|$)') {
  Write-Error "BLOCKED: .env file access via Read tool"
  exit 2
}

exit 0
