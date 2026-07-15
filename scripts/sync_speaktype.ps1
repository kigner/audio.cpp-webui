# Sync the repo's SpeakType/ into the portable release bundle (audiocpp-portable\SpeakType).
# The repo copy is the source of truth; run this after editing SpeakType/ in the repo.
# The bundle reuses the shared venv, so the vendored Python311/ is never copied.
# NOTE: config.json is overwritten from the repo (source of truth). robocopy /E does
#       not delete bundle-only files (e.g. logs), so local logs are preserved.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot            # repo root = parent of scripts\
$src  = Join-Path $repo "SpeakType"
$dst  = Join-Path $repo "audiocpp-portable\SpeakType"
if (-not (Test-Path $src)) { throw "source not found: $src" }

robocopy $src $dst /E /XD __pycache__ .pytest_cache Python311 .git .codegraph /XF *.log *.pyc | Out-Null
$code = $LASTEXITCODE
if ($code -ge 8) { throw "robocopy failed (exit $code)" }

Write-Host "[sync] SpeakType -> audiocpp-portable\SpeakType  (robocopy exit $code, 0-7 = ok)"
Write-Host "[sync] launch with audiocpp-portable\run_speaktype.bat  (needs run_server_asr_stream.bat on :8081)"
