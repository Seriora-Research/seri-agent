# PostToolUse hook (PowerShell variant) - auto-format the file just written/edited.
$file = $env:CLAUDE_TOOL_INPUT_FILE_PATH
if (-not $file) { exit 0 }

$ext = [System.IO.Path]::GetExtension($file).TrimStart(".")

switch ($ext) {
  { $_ -in "ts","tsx","js","jsx","mjs","cjs" } {
    if (Get-Command prettier -ErrorAction SilentlyContinue) {
      prettier --write $file --log-level warn
    }
    if (Get-Command tsc -ErrorAction SilentlyContinue) {
      tsc --noEmit 2>&1 | Select-Object -First 20
    }
  }
  "py" {
    if (Get-Command ruff -ErrorAction SilentlyContinue) {
      ruff format $file
      ruff check --fix $file
    } elseif (Get-Command black -ErrorAction SilentlyContinue) {
      black $file --quiet
    }
  }
}

exit 0
