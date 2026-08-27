# sessionStart - persist this Cursor session id so loop INIT can stamp SESSION.
$payload = [Console]::In.ReadToEnd()
$sid = $null
try {
  $json = $payload | ConvertFrom-Json
  $sid = $json.session_id
  if (-not $sid) { $sid = $json.conversation_id }
} catch {}
if (-not $sid) { exit 0 }
Set-Content -Path ".cursor/session-id" -Value $sid -NoNewline -Encoding ascii
exit 0
