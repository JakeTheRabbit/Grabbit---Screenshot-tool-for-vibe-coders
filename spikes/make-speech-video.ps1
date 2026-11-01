# Test video with real speech, a long pause and a cursor track: for captions, cut-silences and studio tests.
#   pwsh spikes/make-speech-video.ps1 [-Out <folder>]   (Windows PowerShell 5.1 does the speech: System.Speech)
param([string]$Out = (Join-Path $env:TEMP "g2studio"))
New-Item -ItemType Directory -Force $Out | Out-Null
$wav = Join-Path $Out "speech.wav"
$ps = @"
Add-Type -AssemblyName System.Speech
`$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
`$s.SetOutputToWaveFile('$wav')
`$p = New-Object System.Speech.Synthesis.PromptBuilder
`$p.AppendText('Hello, this is the Grabbit caption test.')
`$p.AppendBreak([TimeSpan]::FromSeconds(3))
`$p.AppendText('Now the silence before this sentence should be cut out.')
`$s.Speak(`$p)
`$s.Dispose()
"@
powershell -NoProfile -Command $ps
$mp4 = Join-Path $Out "speech.mp4"
ffmpeg -hide_banner -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30" -i $wav -map 0:v -map 1:a -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata:s:a:0 handler_name="Microphone" $mp4
'{"width":1280,"height":720,"moves":[[0.5,900,200,0],[1.0,900,200,1],[1.1,900,200,0],[1.6,950,240,1],[1.7,950,240,0]],"keys":[[2.4,"LControl"],[2.5,"S"]]}' | Set-Content (Join-Path $Out "speech.cursor.json")
$d = ffprobe -v error -show_entries format=duration -of csv=p=0 $mp4
"made $mp4 ($d s)"
