[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$PortableRoot = "",
    [string]$OutputDir = "",
    [string]$ReleaseTag = "",
    [string]$Repository = "kigner/audio.cpp-webui",
    [Parameter(Mandatory = $true)][string]$MinisignSecretKey,
    [Parameter(Mandatory = $true)][string]$MinisignPublicKey,
    [string]$MinisignPath = "minisign.exe",
    [string]$PythonDepsSource = "",
    [switch]$IncludeUpdater,
    [string]$UpdaterMinisignBinary = "",
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$MinimumUpdater = "1.1.1",
    [string]$SupportedFrom = ">=0.2.0",
    [switch]$Stable,
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if ($PortableRoot -eq "") { $PortableRoot = Join-Path $repoRoot "audiocpp-portable" }
if ($OutputDir -eq "") { $OutputDir = Join-Path $repoRoot "dist\releases\v$Version" }
if ($ReleaseTag -eq "") { $ReleaseTag = "v$Version-windows-prebuilt" }
$PortableRoot = [IO.Path]::GetFullPath($PortableRoot)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$MinisignSecretKey = [IO.Path]::GetFullPath($MinisignSecretKey)
$MinisignPublicKey = [IO.Path]::GetFullPath($MinisignPublicKey)
$stageRoot = Join-Path $OutputDir ".staging"

$preserveRules = @(
    "models/**",
    "webui/voice/**",
    "webui/output/**",
    "webui/logs/**",
    "webui/llm_api_key.txt",
    "webui/configs/ui_language.json",
    "SpeakType/config.json",
    "SpeakType/logs/**",
    "_update/backup/**"
)

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$Arguments = @()
    )
    Write-Host "> $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
    }
}

function Assert-SafeOutputDirectory {
    $fullRepo = $repoRoot.TrimEnd('\')
    $fullOutput = $OutputDir.TrimEnd('\')
    if ($fullOutput -eq $fullRepo -or $fullOutput.Length -lt 4) {
        throw "Unsafe release output directory: $fullOutput"
    }
}

function Copy-PayloadFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$PayloadRoot
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Release input is missing: $Source"
    }
    $relative = $RelativePath.Replace('\', '/').TrimStart('/')
    if ($relative -match '(^|/)\.\.(/|$)' -or $relative -match '^[A-Za-z]:') {
        throw "Unsafe release path: $RelativePath"
    }
    $destination = Join-Path $PayloadRoot $relative.Replace('/', '\')
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $destination -Force
}

function Get-FileIndex {
    param([Parameter(Mandatory = $true)][string]$PayloadRoot)
    $result = @()
    foreach ($file in Get-ChildItem -LiteralPath $PayloadRoot -File -Recurse | Sort-Object FullName) {
        $relative = $file.FullName.Substring($PayloadRoot.Length).TrimStart('\').Replace('\', '/')
        $result += [ordered]@{
            path = $relative
            size = [int64]$file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return @($result)
}

function New-ComponentArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][object[]]$Inputs,
        [string]$ComponentVersion = $Version
    )
    $stage = Join-Path $stageRoot $Id
    $payload = Join-Path $stage "payload"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $payload -Force | Out-Null

    foreach ($input in $Inputs) {
        Copy-PayloadFile -Source ([string]$input.Source) -RelativePath ([string]$input.Path) -PayloadRoot $payload
    }
    $index = [ordered]@{
        schema = 1
        component = $Id
        files = @(Get-FileIndex $payload)
        remove = @()
    }
    $index | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "files.json") -Encoding UTF8

    $zip = Join-Path $OutputDir $FileName
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
    return [pscustomobject]@{
        Id = $Id
        Version = $ComponentVersion
        File = $FileName
        Path = $zip
        Size = [int64](Get-Item -LiteralPath $zip).Length
        Sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-AppInputs {
    $inputs = @()
    $rootFiles = @(
        "_env.bat",
        "run_cli_tts.bat",
        "run_realtime.bat",
        "run_server.bat",
        "run_server_asr.bat",
        "run_server_asr_stream.bat",
        "run_speaktype.bat",
        "run_webui.bat"
    )
    foreach ($relative in $rootFiles) {
        $inputs += [pscustomobject]@{ Source = Join-Path $repoRoot $relative; Path = $relative }
    }

    $tracked = @(& git -C $repoRoot ls-files -- webui SpeakType)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed." }
    foreach ($relative in $tracked) {
        $normalized = ([string]$relative).Replace('\', '/')
        $include = $false
        if ($normalized.StartsWith("webui/")) {
            $include = $normalized -notmatch '^webui/(voice|output|logs)/' -and
                $normalized -notin @("webui/llm_api_key.txt", "webui/configs/ui_language.json") -and
                $normalized -notmatch '^webui/test_.*\.py$'
        } elseif ($normalized.StartsWith("SpeakType/")) {
            $include = $normalized -match '^SpeakType/(app/|web/|third_party/|run\.py$|run_speaktype\.pyw$|run_mock\.pyw$|README\.md$)' -and
                $normalized -notin @("SpeakType/config.json", "SpeakType/logs/.gitkeep")
        }
        if ($include) {
            $inputs += [pscustomobject]@{ Source = Join-Path $repoRoot $normalized.Replace('/', '\'); Path = $normalized }
        }
    }
    return @($inputs)
}

function New-CoreInputs {
    param([Parameter(Mandatory = $true)][ValidateSet("cpu", "gpu")][string]$Directory)
    $inputs = @()
    foreach ($name in @("audiocpp_cli.exe", "audiocpp_server.exe")) {
        $inputs += [pscustomobject]@{
            Source = Join-Path (Join-Path $PortableRoot $Directory) $name
            Path = "$Directory/$name"
        }
    }
    return @($inputs)
}

function New-PythonDepsArchive {
    param([Parameter(Mandatory = $true)][string]$Source)
    $sourceRoot = [IO.Path]::GetFullPath($Source)
    foreach ($required in @("requirements-update.txt", "before-install.json", "after-install-checks.json", "wheels")) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required))) {
            throw "Python dependency source is missing $required."
        }
    }
    $stage = Join-Path $stageRoot "python-deps"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -Force) {
        if ($item.Name -eq "files.json") { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force
    }
    $index = [ordered]@{ schema = 1; component = "python-deps"; files = @(Get-FileIndex $stage) }
    $index | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "files.json") -Encoding UTF8
    $fileName = "audiocpp-python-deps-py311-win-x64-v$Version.zip"
    $zip = Join-Path $OutputDir $fileName
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
    return [pscustomobject]@{
        Id = "python-deps"; Version = $Version; File = $fileName; Path = $zip
        Size = [int64](Get-Item -LiteralPath $zip).Length
        Sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-UpdaterInputs {
    if ($UpdaterMinisignBinary -eq "") { $script:UpdaterMinisignBinary = Join-Path $repoRoot "updater\minisign.exe" }
    $paths = @(
        @{ Source = Join-Path $repoRoot "update.bat"; Path = "update.bat" },
        @{ Source = Join-Path $repoRoot "updater\updater.ps1"; Path = "updater/updater.ps1" },
        @{ Source = Join-Path $repoRoot "updater\apply-update.ps1"; Path = "updater/apply-update.ps1" },
        @{ Source = Join-Path $repoRoot "updater\updater.version"; Path = "updater/updater.version" },
        @{ Source = Join-Path $repoRoot "updater\public-key.txt"; Path = "updater/public-key.txt" },
        @{ Source = Join-Path $repoRoot "updater\README.md"; Path = "updater/README.md" },
        @{ Source = [IO.Path]::GetFullPath($UpdaterMinisignBinary); Path = "updater/minisign.exe" }
    )
    return @($paths | ForEach-Object { [pscustomobject]@{ Source = $_.Source; Path = $_.Path } })
}

function ConvertTo-ManifestComponent {
    param([Parameter(Mandatory = $true)]$Component)
    return [ordered]@{
        id = [string]$Component.Id
        version = [string]$Component.Version
        file = [string]$Component.File
        size = [int64]$Component.Size
        sha256 = [string]$Component.Sha256
        urls = @("https://github.com/$Repository/releases/download/$ReleaseTag/$($Component.File)")
    }
}

function Invoke-Minisign {
    param(
        [Parameter(Mandatory = $true)][string]$MessagePath,
        [Parameter(Mandatory = $true)][string]$SignaturePath
    )
    Invoke-Checked $MinisignPath @("-S", "-s", $MinisignSecretKey, "-m", $MessagePath, "-x", $SignaturePath)
    Invoke-Checked $MinisignPath @("-V", "-m", $MessagePath, "-x", $SignaturePath, "-p", $MinisignPublicKey)
}

Assert-SafeOutputDirectory
if (-not (Test-Path -LiteralPath $PortableRoot -PathType Container)) {
    throw "Portable bundle root not found: $PortableRoot"
}
if (-not (Test-Path -LiteralPath $MinisignSecretKey -PathType Leaf)) {
    throw "Minisign secret key not found: $MinisignSecretKey"
}
if (-not (Test-Path -LiteralPath $MinisignPublicKey -PathType Leaf)) {
    throw "Minisign public key not found: $MinisignPublicKey"
}
if ((Get-Content -LiteralPath $MinisignPublicKey -Raw -Encoding UTF8) -match 'REPLACE_WITH_') {
    throw "Refusing to use a placeholder minisign public key."
}
$packagedUpdaterVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Raw).Trim()
if ([version]$packagedUpdaterVersion -lt [version]$MinimumUpdater) {
    throw "Repository updater $packagedUpdaterVersion is older than -MinimumUpdater $MinimumUpdater."
}
if ([string]::IsNullOrWhiteSpace($SupportedFrom)) {
    throw "-SupportedFrom cannot be empty."
}
foreach ($clause in ($SupportedFrom -split '\s+' | Where-Object { $_ -ne "" })) {
    if ($clause -notmatch '^(>=|<=|>|<|=)?\d+(?:\.\d+){1,3}$') {
        throw "Unsupported -SupportedFrom clause '$clause'."
    }
}
if ($null -eq (Get-Command $MinisignPath -ErrorAction SilentlyContinue)) {
    throw "Minisign executable not found: $MinisignPath"
}
if (-not $AllowDirty) {
    $dirty = @(& git -C $repoRoot status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw "git status failed." }
    if ($dirty.Count -gt 0) { throw "Tracked working tree changes exist. Build release assets from a clean tested commit." }
}

if (Test-Path -LiteralPath $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

$app = New-ComponentArchive "app" "audiocpp-app-v$Version.zip" (Get-AppInputs) $Version
$cpu = New-ComponentArchive "core-cpu" "audiocpp-core-cpu-win-x64-v$Version.zip" (New-CoreInputs "cpu") $Version
$cuda = New-ComponentArchive "core-cuda" "audiocpp-core-cuda-win-x64-v$Version.zip" (New-CoreInputs "gpu") $Version
$components = @($app, $cpu, $cuda)
$hasPythonDeps = $PythonDepsSource -ne ""
if ($hasPythonDeps) { $components += New-PythonDepsArchive $PythonDepsSource }
$hasUpdater = [bool]$IncludeUpdater
if ($hasUpdater) {
    $updaterVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Raw).Trim()
    $components += New-ComponentArchive "updater" "audiocpp-updater-v$updaterVersion.zip" (Get-UpdaterInputs) $updaterVersion
}

$manifestName = "manifest-v$Version.json"
$manifestPath = Join-Path $OutputDir $manifestName
$manifest = [ordered]@{
    schema = 1
    product = "audiocpp-portable"
    platform = "windows-x64"
    version = $Version
    supported_from = $SupportedFrom
    minimum_updater = $MinimumUpdater
    components = @($components | ForEach-Object { ConvertTo-ManifestComponent $_ })
    preserve = $preserveRules
    health_checks = @(
        "cpu-cli-help",
        "cpu-server-help",
        "cuda-cli-help-if-available",
        "cuda-server-help-if-available",
        "python-imports",
        "pip-check",
        "python-compile"
    )
    required_python_imports = @("gradio", "fastapi", "uvicorn")
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Invoke-Minisign $manifestPath "$manifestPath.minisig"

if ($Stable) {
    $stablePath = Join-Path $OutputDir "stable.json"
    $stablePointer = [ordered]@{
        schema = 1
        channel = "stable"
        version = $Version
        published_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        manifest_url = "https://github.com/$Repository/releases/download/$ReleaseTag/$manifestName"
        signature_url = "https://github.com/$Repository/releases/download/$ReleaseTag/$manifestName.minisig"
        notes_url = "https://github.com/$Repository/releases/tag/$ReleaseTag"
    }
    $stablePointer | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stablePath -Encoding UTF8
}

$releaseNotes = @"
# audio.cpp Windows portable v$Version

## Update

- Supported from: 0.2.0 and later 0.2.x portable bundles
- Components: app, core-cpu, core-cuda$(if ($hasPythonDeps) { ', python-deps' })$(if ($hasUpdater) { ', updater' })
- Python dependency changes: $(if ($hasPythonDeps) { 'yes' } else { 'no' })
- CUDA runtime changes: no

## User data

The updater does not overwrite models, custom voices, output files, API keys,
logs, or SpeakType user configuration. Failed updates roll back managed files
from `_update\\backup\\`.
"@
Set-Content -LiteralPath (Join-Path $OutputDir "release-notes.md") -Value $releaseNotes -Encoding UTF8

$sumCandidates = @(Get-ChildItem -LiteralPath $OutputDir -File | Where-Object {
    $_.Name -notin @("SHA256SUMS.txt", "SHA256SUMS.txt.minisig")
} | Sort-Object Name)
$sumLines = @($sumCandidates | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
})
$sumsPath = Join-Path $OutputDir "SHA256SUMS.txt"
Set-Content -LiteralPath $sumsPath -Value $sumLines -Encoding ASCII
Invoke-Minisign $sumsPath "$sumsPath.minisig"

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Write-Host ""
Write-Host "Release assets created in: $OutputDir"
Get-ChildItem -LiteralPath $OutputDir -File | Sort-Object Name | Select-Object Name, Length
