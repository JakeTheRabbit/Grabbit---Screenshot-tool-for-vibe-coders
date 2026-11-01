# Rebuild (optional) and restart the Grabbit 2 debug build with DevTools on port 9333 (for spikes/cdp.mjs).
#   pwsh spikes/run2.ps1 [-Build] [-Then capture|record|"--open <file>"]
param([switch]$Build, [switch]$Test, [switch]$Demo, [string]$Then = "")
$root = Split-Path $PSScriptRoot
$exe = Join-Path $root "app\src-tauri\target\debug\grabbit.exe"
Get-Process grabbit -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if ($Build) {
  Push-Location (Join-Path $root "app")
  $out = & bunx tauri build --debug --no-bundle 2>&1
  Pop-Location
  $err = $out | Select-String -Pattern "^error|error\[" -Context 0, 6
  if ($err) { $err | Out-String; exit 1 }
  "built"
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
Remove-Item Env:GRABBIT_DEMO -ErrorAction SilentlyContinue
if ($Test) { $env:GRABBIT_CONFIG = Join-Path $env:TEMP "g2cfg" }
elseif ($Demo) {
  # README shots: an empty config of its own, and Grabbit's overlays visible to screen capture.
  $d = Join-Path $env:TEMP "g2demo"
  $shots = Join-Path $d "shots"; $vids = Join-Path $d "videos"
  New-Item -ItemType Directory -Force $shots, $vids | Out-Null
  @{ save_folder = $shots; video_folder = $vids; edit_after_recording = $false; copy_recording = $false; index_text = $false } | ConvertTo-Json | Set-Content "$d\settings.json"
  $env:GRABBIT_CONFIG = $d; $env:GRABBIT_DEMO = "1"
}
else { Remove-Item Env:GRABBIT_CONFIG -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
Start-Sleep 2
"grabbit pid $($p.Id) running=$(-not $p.HasExited)"
if ($Then) {
  Start-Process -FilePath $exe -ArgumentList $Then -WindowStyle Hidden -Wait
  Start-Sleep 2
}
