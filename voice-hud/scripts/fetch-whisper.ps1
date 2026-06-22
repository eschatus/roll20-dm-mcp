# Acquire the prebuilt CPU whisper.cpp binaries + the base.en model for packaging on Windows.
# (mac/linux build from source — see fetch-whisper.sh.)
#
# Output layout (matches voice-hud/src/config.ts whisperBin/whisperServerBin on win32):
#   voice-hud/data/whisper/Release/whisper-cli.exe
#   voice-hud/data/whisper/Release/whisper-server.exe
#   voice-hud/data/whisper/Release/*.dll        (ggml/whisper CPU variants)
#   voice-hud/data/models/ggml-base.en.bin
$ErrorActionPreference = "Stop"

$tag  = if ($env:WHISPER_TAG) { $env:WHISPER_TAG } else { "v1.9.1" }
$here = Split-Path -Parent $PSScriptRoot            # voice-hud/
$wdir = Join-Path $here "data\whisper"
$mdir = Join-Path $here "data\models"
New-Item -ItemType Directory -Force -Path $wdir, $mdir | Out-Null

# 1) base.en model — the offline floor.
$model = Join-Path $mdir "ggml-base.en.bin"
if (-not (Test-Path $model)) {
  Write-Host "==> downloading ggml-base.en.bin"
  Invoke-WebRequest -UseBasicParsing -OutFile $model `
    -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"
}

# 2) prebuilt CPU binaries from the official release zip.
if (-not (Test-Path (Join-Path $wdir "Release\whisper-server.exe"))) {
  $zip = Join-Path $env:TEMP "whisper-bin-x64.zip"
  $url = "https://github.com/ggerganov/whisper.cpp/releases/download/$tag/whisper-bin-x64.zip"
  Write-Host "==> downloading $url"
  Invoke-WebRequest -UseBasicParsing -OutFile $zip -Uri $url
  Expand-Archive -Path $zip -DestinationPath $wdir -Force   # zip contains a Release\ folder

  # Normalize: if a build ever ships the binaries flat (no Release\), nest them so config.ts finds them.
  if (-not (Test-Path (Join-Path $wdir "Release\whisper-cli.exe")) -and
      (Test-Path (Join-Path $wdir "whisper-cli.exe"))) {
    $rel = Join-Path $wdir "Release"
    New-Item -ItemType Directory -Force -Path $rel | Out-Null
    Move-Item (Join-Path $wdir "*.exe") $rel -Force
    Move-Item (Join-Path $wdir "*.dll") $rel -Force
  }
}

Write-Host "==> whisper assets ready:"
Get-ChildItem -Recurse $wdir | Select-Object FullName, Length | Format-Table -AutoSize
