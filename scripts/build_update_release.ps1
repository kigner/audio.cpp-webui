[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$PortableRoot = "",
    [string]$BaselineRoot = "",
    [string]$OutputDir = "",
    [string]$ReleaseTag = "",
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')][string]$AssetRevision = "",
    [string]$Repository = "kigner/audio.cpp-webui",
    [string]$HuggingFaceRepository = "kigner/audio.cpp-webui",
    [string]$ReleaseNotesPath = "",
    [Parameter(Mandatory = $true)][string]$MinisignSecretKey,
    [Parameter(Mandatory = $true)][string]$MinisignPublicKey,
    [string]$MinisignPath = "minisign.exe",
    [string]$PythonDepsSource = "",
    [switch]$IncludeUpdater,
    [switch]$IncludeStandaloneApi,
    [string]$UpdaterMinisignBinary = "",
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$MinimumUpdater = "1.2.0",
    [string]$SupportedFrom = "",
    [switch]$Stable,
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$updateBaseline = "0.7.0"
if ([version]$Version -lt [version]$updateBaseline) {
    throw "This builder targets baseline $updateBaseline and later. Keep the existing legacy release assets."
}
if ([version]$MinimumUpdater -lt [version]"1.2.0") { throw "This release requires updater 1.2.0 or later." }
# Always retain the baseline floor, even when a caller supplies a broader range.
$SupportedFrom = (">=$updateBaseline " + $SupportedFrom).Trim()
$hfReleasePath = "updates/v$updateBaseline/v$Version"
$assetSuffix = if ($AssetRevision -eq "") { "" } else { "-$AssetRevision" }
if ($PortableRoot -eq "") { $PortableRoot = Join-Path $repoRoot "audiocpp-portable" }
if ($OutputDir -eq "") { $OutputDir = Join-Path $repoRoot "dist\releases\v$Version$assetSuffix" }
if ($ReleaseTag -eq "") { $ReleaseTag = "v$Version-windows-prebuilt" }
$PortableRoot = [IO.Path]::GetFullPath($PortableRoot)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$MinisignSecretKey = [IO.Path]::GetFullPath($MinisignSecretKey)
$MinisignPublicKey = [IO.Path]::GetFullPath($MinisignPublicKey)
if ($ReleaseNotesPath -ne "") { $ReleaseNotesPath = [IO.Path]::GetFullPath($ReleaseNotesPath) }
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
        [string]$ComponentVersion = $Version,
        [string[]]$RemovePaths = @()
    )
    $selected = @()
    $reused = 0
    foreach ($input in $Inputs) {
        $relative = ([string]$input.Path).Replace('\', '/')
        if ($relative -match '(^|/)\.\.(/|$)|^[A-Za-z]:|^/') { throw "Unsafe release path: $relative" }
        $source = [string]$input.Source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release input is missing: $source" }
        if ($BaselineRoot -ne "") {
            $previous = Join-Path $BaselineRoot $relative.Replace('/', '\')
            if ((Test-Path -LiteralPath $previous -PathType Leaf) -and
                (Get-Item -LiteralPath $previous).Length -eq (Get-Item -LiteralPath $source).Length -and
                (Get-FileHash -LiteralPath $previous -Algorithm SHA256).Hash -eq
                (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
                $reused++
                continue
            }
        }
        $selected += $input
    }
    Write-Host "${Id}: $($selected.Count) changed/new files, $reused unchanged baseline files reused."
    if ($selected.Count -eq 0 -and $RemovePaths.Count -eq 0) { return $null }

    $stage = Join-Path $stageRoot $Id
    $payload = Join-Path $stage "payload"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $payload -Force | Out-Null

    foreach ($input in $selected) {
        Copy-PayloadFile -Source ([string]$input.Source) -RelativePath ([string]$input.Path) -PayloadRoot $payload
    }
    $index = [ordered]@{
        schema = 1
        component = $Id
        files = @(Get-FileIndex $payload)
        remove = @($RemovePaths)
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
    # Explicit startup dependencies must not disappear through tracked-file filtering.
    $requiredFiles = @(
        "_env.bat",
        "run_webui.bat",
        "webui/start_webui.bat",
        "webui/backend_probe.py",
        "webui/workbench_static/i18n.js",
        "webui/workbench_static/locales/en.json",
        "webui/README.md",
        "webui/README.zh.md"
    )
    if ($IncludeStandaloneApi) {
        $requiredFiles += @("run_server.bat", "run_server_asr.bat", "run_server_asr_stream.bat")
    }
    foreach ($relative in $requiredFiles) {
        $inputs += [pscustomobject]@{ Source = Join-Path $repoRoot $relative; Path = $relative }
    }

    $tracked = @(& git -C $repoRoot ls-files -- `
        webui `
        SpeakType `
        tools/model_manager_v2.py `
        tools/model_manager_deprecated.py `
        tools/community_models/convert_glm_tts.py `
        assets/model_manager `
        assets/framework/models/marblenet_vad `
        model_specs)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed." }
    foreach ($relative in $tracked) {
        $normalized = ([string]$relative).Replace('\', '/')
        if ($normalized -in $requiredFiles) { continue }
        $include = $false
        if ($normalized.StartsWith("webui/")) {
            $include = $normalized -notmatch '^webui/(voice|output|logs)/' -and
                $normalized -notin @("webui/llm_api_key.txt", "webui/configs/ui_language.json",
                    "webui/_env.bat", "webui/run_webui.bat", "webui/run_webui.sh") -and
                $normalized -notmatch '^webui/test_[^/]+$' -and
                $normalized -notmatch '(^|/)(__pycache__|node_modules|\.svelte-kit)/|\.pyc$'
            if ($normalized.StartsWith("webui/native/")) {
                # Keep existing native runtime assets, not its source/build inputs.
                $include = $normalized -eq "webui/native/dist/index.html" -or
                    $normalized.StartsWith("webui/native/demo_voices/")
            }
        } elseif ($normalized.StartsWith("SpeakType/")) {
            $include = $normalized -match '^SpeakType/(app/|web/|third_party/|run\.py$|README\.md$)' -and
                $normalized -notin @("SpeakType/config.json", "SpeakType/logs/.gitkeep")
        } elseif ($normalized -in @(
                      "tools/model_manager_v2.py",
                      "tools/model_manager_deprecated.py",
                      "tools/community_models/convert_glm_tts.py"
                  ) -or
                  $normalized.StartsWith("assets/model_manager/") -or
                  $normalized.StartsWith("assets/framework/models/marblenet_vad/") -or
                  $normalized.StartsWith("model_specs/")) {
            $include = $true
        }
        if ($include) {
            $inputs += [pscustomobject]@{ Source = Join-Path $repoRoot $normalized.Replace('/', '\'); Path = $normalized }
        }
    }
    return @($inputs)
}

function Get-AppRemovePaths {
    # Exact previously distributed app files only. Never delete whole directories:
    # the updater backs up each file and restores it if a later health check fails.
    $paths = @(
        "run_cli_tts.bat",
        "run_realtime.bat",
        "run_speaktype.bat",
        "SpeakType/run_mock.pyw",
        "SpeakType/run_speaktype.pyw",
        "webui/_env.bat",
        "webui/run_webui.bat",
        "webui/run_webui.sh",
        "webui/native/package.json",
        "webui/native/package-lock.json",
        "webui/native/svelte.config.js",
        "webui/native/tsconfig.json",
        "webui/native/vite.config.ts",
        "webui/native/lang/README.md",
        "webui/native/lang/lang_it.json",
        "webui/native/lang/lang_pl.json",
        "webui/native/lang/lang_ru.json",
        "webui/native/lang/lang_zh.json",
        "webui/native/src/app.css",
        "webui/native/src/app.html",
        "webui/native/src/lib/api.ts",
        "webui/native/src/lib/audio.ts",
        "webui/native/src/lib/catalog.ts",
        "webui/native/src/lib/i18n.ts",
        "webui/native/src/lib/text.ts",
        "webui/native/src/lib/types.ts",
        "webui/native/src/lib/voices.ts",
        "webui/native/src/routes/+page.svelte",
        "webui/native/src/routes/+page.ts"
    )
    if (-not $IncludeStandaloneApi) {
        $paths += @("run_server.bat", "run_server_asr.bat", "run_server_asr_stream.bat")
    }
    return $paths
}

function New-CoreInputs {
    param([Parameter(Mandatory = $true)][ValidateSet("cpu", "gpu", "vulkan")][string]$Directory)
    $inputs = @()
    foreach ($name in @("audiocpp_cli.exe", "audiocpp_server.exe", "audiocpp_gguf.exe")) {
        $inputs += [pscustomobject]@{
            Source = Join-Path (Join-Path $PortableRoot $Directory) $name
            Path = "$Directory/$name"
        }
    }
    foreach ($dll in @(Get-ChildItem -LiteralPath (Join-Path $PortableRoot $Directory) -Filter '*.dll' -File |
            Where-Object { $_.Name -notin @('espeak_test_library.dll', 'espeak_test_missing_symbol.dll') } | Sort-Object Name)) {
        $inputs += [pscustomobject]@{ Source = $dll.FullName; Path = "$Directory/$($dll.Name)" }
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
    $fileName = "audiocpp-python-deps-py311-win-x64-v$Version$assetSuffix.zip"
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
        urls = @(
            "https://github.com/$Repository/releases/download/$ReleaseTag/$($Component.File)",
            "https://huggingface.co/$HuggingFaceRepository/resolve/main/$hfReleasePath/$($Component.File)",
            "https://hf-mirror.com/$HuggingFaceRepository/resolve/main/$hfReleasePath/$($Component.File)"
        )
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
if ($BaselineRoot -eq "" -and [version]$Version -gt [version]$updateBaseline) {
    throw "Incremental releases require -BaselineRoot pointing to the original $updateBaseline full package."
}
if ($BaselineRoot -ne "") {
    $BaselineRoot = [IO.Path]::GetFullPath($BaselineRoot)
    $baselineVersion = Get-Content -LiteralPath (Join-Path $BaselineRoot 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$baselineVersion.version -ne $updateBaseline) {
        throw "BaselineRoot must contain the original $updateBaseline full package."
    }
    foreach ($required in @('run_webui.bat', 'cpu/audiocpp_cli.exe', 'gpu/audiocpp_server.exe', 'vulkan/audiocpp_server.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $BaselineRoot $required) -PathType Leaf)) {
            throw "BaselineRoot is missing $required."
        }
    }
}
if (-not (Test-Path -LiteralPath $MinisignSecretKey -PathType Leaf)) {
    throw "Minisign secret key not found: $MinisignSecretKey"
}
if (-not (Test-Path -LiteralPath $MinisignPublicKey -PathType Leaf)) {
    throw "Minisign public key not found: $MinisignPublicKey"
}
if ($ReleaseNotesPath -ne "" -and -not (Test-Path -LiteralPath $ReleaseNotesPath -PathType Leaf)) {
    throw "Release notes file not found: $ReleaseNotesPath"
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

if (Test-Path -LiteralPath $OutputDir) { throw "Output directory already exists; keep reviewed release assets and choose a new directory: $OutputDir" }
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

$app = New-ComponentArchive "app" "audiocpp-app-v$Version$assetSuffix.zip" (Get-AppInputs) $Version -RemovePaths (Get-AppRemovePaths)
$cpu = New-ComponentArchive "core-cpu" "audiocpp-core-cpu-win-x64-v$Version$assetSuffix.zip" (New-CoreInputs "cpu") $Version
$cuda = New-ComponentArchive "core-cuda" "audiocpp-core-cuda-win-x64-v$Version$assetSuffix.zip" (New-CoreInputs "gpu") $Version
$vulkan = New-ComponentArchive "core-vulkan" "audiocpp-core-vulkan-win-x64-v$Version$assetSuffix.zip" (New-CoreInputs "vulkan") $Version
$components = @(@($app, $cpu, $cuda, $vulkan) | Where-Object { $null -ne $_ })
$hasPythonDeps = $PythonDepsSource -ne ""
if ($hasPythonDeps) { $components += New-PythonDepsArchive $PythonDepsSource }
$hasUpdater = [bool]$IncludeUpdater
if ($hasUpdater) {
    $updaterVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Raw).Trim()
    $updater = New-ComponentArchive "updater" "audiocpp-updater-v$updaterVersion$assetSuffix.zip" (Get-UpdaterInputs) $updaterVersion
    if ($null -ne $updater) { $components += $updater }
}
if ($components.Count -eq 0) { throw "No changed files or dependency updates were selected." }

$manifestName = "manifest-v$Version$assetSuffix.json"
$manifestPath = Join-Path $OutputDir $manifestName
$manifest = [ordered]@{
    schema = 1
    product = "audiocpp-portable"
    platform = "windows-x64"
    version = $Version
    update_baseline = $updateBaseline
    supported_from = $SupportedFrom
    minimum_updater = $MinimumUpdater
    components = @($components | ForEach-Object { ConvertTo-ManifestComponent $_ })
    preserve = $preserveRules
    health_checks = @(
        "cpu-cli-help",
        "cpu-server-help",
        "cuda-cli-help-if-available",
        "cuda-server-help-if-available",
        "vulkan-cli-help-if-available",
        "vulkan-server-help-if-available",
        "python-imports",
        "pip-check",
        "python-compile"
    )
    required_python_imports = @("gradio", "fastapi", "uvicorn")
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Invoke-Minisign $manifestPath "$manifestPath.minisig"

if ($Stable) {
    $stablePath = Join-Path $OutputDir "stable-v$updateBaseline.json"
    $stablePointer = [ordered]@{
        schema = 1
        channel = "stable"
        version = $Version
        update_baseline = $updateBaseline
        published_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        manifest_url = "https://github.com/$Repository/releases/download/$ReleaseTag/$manifestName"
        signature_url = "https://github.com/$Repository/releases/download/$ReleaseTag/$manifestName.minisig"
        notes_url = "https://github.com/$Repository/releases/tag/$ReleaseTag"
    }
    $stablePointer | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stablePath -Encoding UTF8
    # Relative assets keep the HF mirror independent of a failed huggingface.co route.
    $stablePointer.manifest_url = "v$Version/$manifestName"
    $stablePointer.signature_url = "v$Version/$manifestName.minisig"
    $stablePointer | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutputDir "stable-v$updateBaseline.huggingface.json") -Encoding UTF8
    # Old clients always request latest/download/stable.json, even after a new Latest release.
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update_legacy_stable.json') -Destination (Join-Path $OutputDir 'stable.json')
}

$releaseNotesOutput = Join-Path $OutputDir "release-notes.md"
if ($ReleaseNotesPath -ne "") {
    Copy-Item -LiteralPath $ReleaseNotesPath -Destination $releaseNotesOutput -Force
} else {
    $releaseNotes = @"
# Aixora Audio Windows portable v$Version

## Update

- Supported from: $SupportedFrom (full-package baseline $updateBaseline)
- Versions below $updateBaseline must install the full Aixora-Studio.zip package; their legacy channel remains at 0.6.0.
- Components: app, core-cpu, core-cuda, core-vulkan$(if ($hasPythonDeps) { ', python-deps' })$(if ($hasUpdater) { ', updater' })
- Python dependency changes: $(if ($hasPythonDeps) { 'yes' } else { 'no' })
- Only files changed since the full-package baseline are downloaded; unchanged runtime libraries are reused.

## User data

The updater does not overwrite models, custom voices, output files, API keys,
logs, or SpeakType user configuration. Failed updates roll back managed files
from `_update\\backup\\`.
"@
    Set-Content -LiteralPath $releaseNotesOutput -Value $releaseNotes -Encoding UTF8
}

$sumCandidates = @(Get-ChildItem -LiteralPath $OutputDir -File | Where-Object {
    $_.Name -notin @("SHA256SUMS$assetSuffix.txt", "SHA256SUMS$assetSuffix.txt.minisig")
} | Sort-Object Name)
$sumLines = @($sumCandidates | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
})
$sumsPath = Join-Path $OutputDir "SHA256SUMS$assetSuffix.txt"
Set-Content -LiteralPath $sumsPath -Value $sumLines -Encoding ASCII
Invoke-Minisign $sumsPath "$sumsPath.minisig"

$hfUploads = @(Get-ChildItem -LiteralPath $OutputDir -File | Sort-Object Name | ForEach-Object {
    [ordered]@{ local_file = $_.Name; path_in_repo = "$hfReleasePath/$($_.Name)"; phase = "assets" }
})
if ($Stable) {
    $hfUploads += [ordered]@{
        local_file = "stable-v$updateBaseline.huggingface.json"
        path_in_repo = "updates/v$updateBaseline/stable.json"
        phase = "promote-after-verification"
    }
}
[ordered]@{
    repository = $HuggingFaceRepository
    revision = "main"
    full_bundle = "Aixora-Studio.zip"
    files = $hfUploads
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutputDir 'huggingface-upload.json') -Encoding UTF8

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Write-Host ""
Write-Host "Release assets created in: $OutputDir"
Get-ChildItem -LiteralPath $OutputDir -File | Sort-Object Name | Select-Object Name, Length
