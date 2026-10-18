# Sync only SpeakType runtime files. Keep the portable user's config and logs.
# The shared Python environment is managed separately.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot            # repo root = parent of scripts\
$src  = Join-Path $repo "SpeakType"
$dst  = Join-Path $repo "audiocpp-portable\SpeakType"
if (-not (Test-Path $src)) { throw "source not found: $src" }

New-Item -ItemType Directory -Path $dst -Force | Out-Null
foreach ($directory in @("app", "web", "third_party")) {
    robocopy (Join-Path $src $directory) (Join-Path $dst $directory) /E /XD __pycache__ .pytest_cache .git .codegraph /XF *.log *.pyc | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $directory (exit $LASTEXITCODE)" }
}
foreach ($name in @("run.py", "README.md")) {
    Copy-Item -LiteralPath (Join-Path $src $name) -Destination (Join-Path $dst $name) -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $dst "config.json"))) {
    Copy-Item -LiteralPath (Join-Path $src "config.json") -Destination (Join-Path $dst "config.json")
}
Write-Host "[sync] SpeakType runtime synchronized; existing user configuration and logs preserved."
Write-Host "[sync] Open run_webui.bat, then Scenarios > Global dictation."
