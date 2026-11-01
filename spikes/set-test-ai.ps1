# Point the test config's AI at the local 9router (OpenAI-compatible) vision combo.
$k = [Environment]::GetEnvironmentVariable("NINEROUTER_API_KEY", "User")
if (-not $k) { $k = [Environment]::GetEnvironmentVariable("NINEROUTER_API_KEY", "Machine") }
"9router key present: $([bool]$k)"
$p = Join-Path $env:TEMP "g2cfg\settings.json"
$s = Get-Content $p -Raw | ConvertFrom-Json
$ai = [pscustomobject]@{ provider = "openai"; openai_key = $k; openai_base = "http://127.0.0.1:20128/v1"; chat_model = "vision"; image_model = ""; xai_key = ""; google_key = ""; auto_describe = $false }
$s | Add-Member -Force -NotePropertyName ai -NotePropertyValue $ai
$s | ConvertTo-Json -Depth 5 | Set-Content $p
