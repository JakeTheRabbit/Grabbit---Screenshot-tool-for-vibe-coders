# Every Windows check in one go: unit tests, self-test, then the end-to-end flows against the debug build.
#   pwsh spikes/all.ps1 [-NoBuild]
param([switch]$NoBuild)
$root = Split-Path $PSScriptRoot
$fail = 0
function Step($name, [scriptblock]$run) {
  $out = & $run 2>&1 | Out-String
  $ok = $LASTEXITCODE -eq 0
  if (-not $ok) { $script:fail++ }
  "{0} {1}" -f ($(if ($ok) { "PASS" } else { "FAIL" }), $name)
  if (-not $ok) { ($out -split "`n" | Select-String "FAIL|error|panicked" | Select-Object -First 8) -join "`n" }
}
Push-Location (Join-Path $root "app\src-tauri")
Step "unit tests" { cargo test --lib -q }
Pop-Location
if (-not $NoBuild) { & (Join-Path $PSScriptRoot "run2.ps1") -Build -Test | Out-Null } else { & (Join-Path $PSScriptRoot "run2.ps1") -Test | Out-Null }
Start-Sleep 3
Step "self-test" {
  $log = Join-Path $env:TEMP "g2self.txt"
  $p = Start-Process -FilePath (Join-Path $root "app\src-tauri\target\debug\grabbit.exe") -ArgumentList "--self-test", (Join-Path $env:TEMP "g2self") -NoNewWindow -PassThru -RedirectStandardOutput $log
  if (-not $p.WaitForExit(240000)) { $p.Kill(); "self-test TIMED OUT"; $global:LASTEXITCODE = 1; return }
  Get-Content $log
  $global:LASTEXITCODE = $p.ExitCode
}
& (Join-Path $PSScriptRoot "run2.ps1") -Test | Out-Null
Start-Sleep 3
foreach ($t in "p11-capture-flow", "p13-record", "p14-editor", "p15-video", "p16-scroll", "p18-ai-pack") {
  Step $t { node (Join-Path $PSScriptRoot "$t.mjs") }
}
if ($fail) { "$fail FAILED"; exit 1 } else { "ALL PASS" }
