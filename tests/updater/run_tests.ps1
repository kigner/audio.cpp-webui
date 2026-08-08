[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$testRoot = Join-Path $PSScriptRoot ".tmp-$PID"
$testUpdaterVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Raw).Trim()
$requiredPreserve = @(
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

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Write-Json {
    param($Value, [string]$Path)
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function New-TestBundle {
    param(
        [string]$Name,
        [string]$BundleVersion = "0.2.0",
        [string]$AppVersion = $BundleVersion,
        [string]$CoreCpuVersion = $BundleVersion,
        [string]$CoreCudaVersion = $BundleVersion
    )
    $root = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $root "updater") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "update.bat") -Destination (Join-Path $root "update.bat")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\updater.ps1") -Destination (Join-Path $root "updater\updater.ps1")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\apply-update.ps1") -Destination (Join-Path $root "updater\apply-update.ps1")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Destination (Join-Path $root "updater\updater.version")
    Set-Content -LiteralPath (Join-Path $root "updater\test-public-key.txt") -Value "test public key" -Encoding ASCII
    $verifier = Join-Path $root "updater\test-minisign.cmd"
    @(
        "@echo off",
        "findstr /c:`"VALID_TEST_SIGNATURE`" `"%~5`" >nul 2>nul",
        "if errorlevel 1 exit /b 1",
        "exit /b 0"
    ) | Set-Content -LiteralPath $verifier -Encoding ASCII
    $version = [ordered]@{
        product = "audiocpp-portable"
        version = $BundleVersion
        channel = "stable"
        platform = "windows-x64"
        python = "3.11"
        components = [ordered]@{
            app = $AppVersion
            core_cpu = $CoreCpuVersion
            core_cuda = $CoreCudaVersion
            python_env = "0.2.0"
            updater = $testUpdaterVersion
        }
    }
    Write-Json $version (Join-Path $root "version.json")
    return $root
}

function New-TestArchive {
    param(
        [string]$Directory,
        [string]$FileName,
        [string]$ManagedPath,
        [string]$Content = "new managed content",
        [string]$Component = "app"
    )
    $stage = Join-Path $Directory ("stage-" + [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    $filePath = Join-Path $payload $ManagedPath.Replace('/', '\')
    New-Item -ItemType Directory -Path (Split-Path $filePath -Parent) -Force | Out-Null
    Set-Content -LiteralPath $filePath -Value $Content -Encoding UTF8
    $file = Get-Item -LiteralPath $filePath
    $index = [ordered]@{
        schema = 1
        component = $Component
        files = @([ordered]@{
            path = $ManagedPath
            size = [int64]$file.Length
            sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        })
        remove = @()
    }
    Write-Json $index (Join-Path $stage "files.json")
    $archive = Join-Path $Directory $FileName
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
    Remove-Item -LiteralPath $stage -Recurse -Force
    return $archive
}

function New-MultiFileComponentArchive {
    param(
        [string]$Directory,
        [string]$FileName,
        [string]$Component,
        [object[]]$Inputs
    )
    $stage = Join-Path $Directory ("stage-" + [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    $indexFiles = @()
    foreach ($input in $Inputs) {
        $destination = Join-Path $payload ([string]$input.Path).Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath ([string]$input.Source) -Destination $destination -Force
        $item = Get-Item -LiteralPath $destination
        $indexFiles += [ordered]@{
            path = [string]$input.Path
            size = [int64]$item.Length
            sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    Write-Json ([ordered]@{ schema = 1; component = $Component; files = $indexFiles; remove = @() }) (Join-Path $stage "files.json")
    $archive = Join-Path $Directory $FileName
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
    Remove-Item -LiteralPath $stage -Recurse -Force
    return $archive
}

function New-ComponentDescriptor {
    param([string]$Id, [string]$Version, [string]$Archive)
    $item = Get-Item -LiteralPath $Archive
    return [ordered]@{
        id = $Id
        version = $Version
        file = $item.Name
        size = [int64]$item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        urls = @($item.Name)
    }
}

function New-CustomManifest {
    param(
        [string]$Directory,
        [object[]]$Components,
        [string]$MinimumUpdater = $testUpdaterVersion,
        [string[]]$HealthChecks = @(),
        [string]$ManifestVersion = "0.2.1",
        [string]$SupportedFrom = ">=0.2.0 <0.3.0"
    )
    $value = [ordered]@{
        schema = 1
        product = "audiocpp-portable"
        platform = "windows-x64"
        version = $ManifestVersion
        supported_from = $SupportedFrom
        minimum_updater = $MinimumUpdater
        components = $Components
        preserve = $requiredPreserve
        health_checks = $HealthChecks
    }
    $path = Join-Path $Directory "manifest-custom.json"
    Write-Json $value $path
    Set-Content -LiteralPath "$path.minisig" -Value "VALID_TEST_SIGNATURE" -Encoding ASCII
    return $path
}

function New-PythonDependencyArchive {
    param([string]$Directory, [string]$FileName = "python-deps.zip")
    $stage = Join-Path $Directory ("python-stage-" + [guid]::NewGuid().ToString("N"))
    $wheels = Join-Path $stage "wheels"
    New-Item -ItemType Directory -Path $wheels -Force | Out-Null
    $wheel = Join-Path $wheels "demo_dep-2.0-py3-none-any.whl"
    Set-Content -LiteralPath $wheel -Value "fake wheel" -Encoding ASCII
    $wheelHash = (Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $stage "requirements-update.txt") -Value "demo-dep==2.0 --hash=sha256:$wheelHash" -Encoding ASCII
    $paths = @("venv/Lib/site-packages/demo_dep", "venv/Lib/site-packages/demo_dep-1.0.dist-info")
    Write-Json ([ordered]@{ schema = 1; packages = @([ordered]@{ name = "demo-dep"; version = "1.0"; paths = $paths }) }) (Join-Path $stage "before-install.json")
    $afterPaths = @("venv/Lib/site-packages/demo_dep", "venv/Lib/site-packages/demo_dep-2.0.dist-info")
    Write-Json ([ordered]@{ schema = 1; packages = @([ordered]@{ name = "demo-dep"; version = "2.0"; paths = $afterPaths }) }) (Join-Path $stage "after-install-checks.json")
    $indexFiles = @()
    foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
        $relative = $file.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/')
        $indexFiles += [ordered]@{ path = $relative; size = [int64]$file.Length; sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    Write-Json ([ordered]@{ schema = 1; component = "python-deps"; files = $indexFiles }) (Join-Path $stage "files.json")
    $archive = Join-Path $Directory $FileName
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
    Remove-Item -LiteralPath $stage -Recurse -Force
    return $archive
}

function New-FakePortablePython {
    param([string]$Root)
    $cache = Join-Path $testRoot "fake-python.exe"
    if (-not (Test-Path -LiteralPath $cache)) {
        $source = @'
using System;
using System.IO;
using System.Linq;
public static class FakePython {
  public static int Main(string[] args) {
    string root = AppDomain.CurrentDomain.BaseDirectory;
    string state = Path.Combine(root, "pip-state.txt");
    string joined = String.Join(" ", args).ToLowerInvariant();
    if (joined.Contains("pip list")) {
      string version = File.Exists(state) ? File.ReadAllText(state).Trim() : "1.0";
      Console.WriteLine("[{\"name\":\"demo-dep\",\"version\":\"" + version + "\"}]");
      return 0;
    }
    if (joined.Contains("pip install")) {
      string site = Path.Combine(root, "Lib", "site-packages");
      string package = Path.Combine(site, "demo_dep");
      string metadata = Path.Combine(site, "demo_dep-2.0.dist-info");
      Directory.CreateDirectory(package);
      Directory.CreateDirectory(metadata);
      File.WriteAllText(Path.Combine(package, "__init__.py"), "new dependency content");
      File.WriteAllText(Path.Combine(metadata, "METADATA"), "Version: 2.0");
      File.WriteAllText(state, "2.0");
      return File.Exists(Path.Combine(root, "fail-install")) ? 1 : 0;
    }
    if (joined.Contains("pip check") || joined.Contains("compileall") || args.Contains("-c")) return 0;
    return 0;
  }
}
'@
        Add-Type -TypeDefinition $source -OutputAssembly $cache -OutputType ConsoleApplication
    }
    $venv = Join-Path $Root "venv"
    $site = Join-Path $venv "Lib\site-packages"
    New-Item -ItemType Directory -Path (Join-Path $site "demo_dep") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $site "demo_dep-1.0.dist-info") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $site "demo_dep\__init__.py") -Value "old dependency content" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $site "demo_dep-1.0.dist-info\METADATA") -Value "Version: 1.0" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $venv "pip-state.txt") -Value "1.0" -Encoding ASCII
    Copy-Item -LiteralPath $cache -Destination (Join-Path $venv "python.exe") -Force
}

function New-TestManifest {
    param(
        [string]$Directory,
        [string]$Archive,
        [string[]]$HealthChecks = @(),
        [string]$Sha256 = ""
    )
    $archiveItem = Get-Item -LiteralPath $Archive
    if ($Sha256 -eq "") { $Sha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() }
    $manifest = [ordered]@{
        schema = 1
        product = "audiocpp-portable"
        platform = "windows-x64"
        version = "0.2.1"
        supported_from = ">=0.2.0 <0.3.0"
        minimum_updater = "1.0.0"
        components = @([ordered]@{
            id = "app"
            version = "0.2.1"
            file = $archiveItem.Name
            size = [int64]$archiveItem.Length
            sha256 = $Sha256
            urls = @($archiveItem.Name)
        })
        preserve = $requiredPreserve
        health_checks = $HealthChecks
    }
    $path = Join-Path $Directory "manifest-v0.2.1.json"
    Write-Json $manifest $path
    Set-Content -LiteralPath "$path.minisig" -Value "VALID_TEST_SIGNATURE" -Encoding ASCII
    return $path
}

function Invoke-TestUpdater {
    param(
        [string]$Root,
        [string]$Mode,
        [string]$Manifest
    )
    $scriptPath = Join-Path $Root "updater\updater.ps1"
    $verifier = Join-Path $Root "updater\test-minisign.cmd"
    $publicKey = Join-Path $Root "updater\test-public-key.txt"
    $output = @(& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $scriptPath $Mode `
        --manifest $Manifest -MinisignPath $verifier -PublicKeyPath $publicKey 2>&1)
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
}

function Invoke-TestBatchUpdater {
    param(
        [string]$Root,
        [string[]]$Arguments
    )
    $batchPath = Join-Path $Root "update.bat"
    $output = @(& $batchPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
}

function Test-CheckMode {
    $root = New-TestBundle "check"
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/managed.txt"
    $manifest = New-TestManifest $assets $archive
    $result = Invoke-TestUpdater $root "--check" $manifest
    Assert-True ($result.ExitCode -eq 0) "check mode failed: $($result.Output)"
    Assert-True ((Read-JsonFile (Join-Path $root "version.json")).version -eq "0.2.0") "check mode changed version.json"
}

function Test-BatchStableChannelCheck {
    $root = New-TestBundle "batch entry with spaces"
    $assets = Join-Path $root "release assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/managed.txt"
    $manifest = New-TestManifest $assets $archive
    $stable = Join-Path $assets "stable.json"
    Write-Json ([ordered]@{
        schema = 1
        channel = "stable"
        version = "0.2.1"
        manifest_url = $manifest
        signature_url = "$manifest.minisig"
        notes_url = "https://example.invalid/audio.cpp/v0.2.1"
    }) $stable
    $result = Invoke-TestBatchUpdater $root @(
        "--check", "-StableUrl", $stable,
        "-MinisignPath", (Join-Path $root "updater\test-minisign.cmd"),
        "-PublicKeyPath", (Join-Path $root "updater\test-public-key.txt")
    )
    Assert-True ($result.ExitCode -eq 0) "update.bat stable-channel check failed: $($result.Output)"
    Assert-True ($result.Output -match "Target version\s+: 0\.2\.1") "update.bat did not report the stable target version"
}

function Read-JsonFile {
    param([string]$Path)
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Test-DryRunAndHashValidation {
    $root = New-TestBundle "dry-run"
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/managed.txt"
    $manifest = New-TestManifest $assets $archive
    $result = Invoke-TestUpdater $root "--dry-run" $manifest
    Assert-True ($result.ExitCode -eq 0) "dry run failed: $($result.Output)"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root "webui\managed.txt"))) "dry run installed a file"

    $badManifest = New-TestManifest $assets $archive @() ("0" * 64)
    $result = Invoke-TestUpdater $root "--dry-run" $badManifest
    Assert-True ($result.ExitCode -ne 0) "dry run accepted an invalid archive hash"
}

function Test-ApplySuccessAndPreserve {
    $root = New-TestBundle "apply"
    New-Item -ItemType Directory -Path (Join-Path $root "webui\voice") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root "webui\voice\user.wav") -Value "user data" -Encoding ASCII
    New-Item -ItemType Directory -Path (Join-Path $root "webui") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root "webui\managed.txt") -Value "old managed content" -Encoding UTF8
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/managed.txt" "new managed content"
    $manifest = New-TestManifest $assets $archive
    $result = Invoke-TestUpdater $root "--apply" $manifest
    Assert-True ($result.ExitCode -eq 0) "apply failed: $($result.Output)"
    Assert-True ((Get-Content -LiteralPath (Join-Path $root "webui\managed.txt") -Raw) -match "new managed content") "managed file was not replaced"
    Assert-True ((Get-Content -LiteralPath (Join-Path $root "webui\voice\user.wav") -Raw) -match "user data") "preserved file changed"
    Assert-True ((Read-JsonFile (Join-Path $root "version.json")).version -eq "0.2.1") "version.json was not committed last"
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $root "_update\backup") -Directory).Count -eq 1) "previous-version backup was not retained"
}

function Test-RollbackOnHealthFailure {
    $root = New-TestBundle "rollback"
    New-Item -ItemType Directory -Path (Join-Path $root "webui") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root "webui\managed.txt") -Value "old rollback content" -Encoding UTF8
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/managed.txt" "bad new content"
    $manifest = New-TestManifest $assets $archive @("python-compile")
    $result = Invoke-TestUpdater $root "--apply" $manifest
    Assert-True ($result.ExitCode -ne 0) "health-check failure unexpectedly succeeded"
    Assert-True ((Get-Content -LiteralPath (Join-Path $root "webui\managed.txt") -Raw) -match "old rollback content") "rollback did not restore managed file"
    Assert-True ((Read-JsonFile (Join-Path $root "version.json")).version -eq "0.2.0") "failed update changed version.json"
}

function Test-ProtectedPathAndLock {
    $root = New-TestBundle "protected"
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets "app.zip" "webui/voice/user.wav"
    $manifest = New-TestManifest $assets $archive
    $result = Invoke-TestUpdater $root "--dry-run" $manifest
    Assert-True ($result.ExitCode -ne 0) "updater accepted a protected payload path"

    New-Item -ItemType Directory -Path (Join-Path $root "_update") -Force | Out-Null
    $lockPath = Join-Path $root "_update\update.lock"
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $result = Invoke-TestUpdater $root "--check" $manifest
        Assert-True ($result.ExitCode -ne 0) "updater ignored an active lock"
        Assert-True (Test-Path -LiteralPath $lockPath) "updater removed another process's active lock"
    } finally {
        $lockStream.Dispose()
    }

    Set-Content -LiteralPath $lockPath -Value "stale interrupted update" -Encoding ASCII
    $result = Invoke-TestUpdater $root "--check" $manifest
    Assert-True ($result.ExitCode -eq 0) "updater did not recover from a stale lock: $($result.Output)"
    Assert-True (-not (Test-Path -LiteralPath $lockPath)) "updater left the recovered stale lock behind"
}

function Test-PythonDependencyUpdateAndRollback {
    $root = New-TestBundle "python-success"
    New-FakePortablePython $root
    $assets = Join-Path $root "assets"
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-PythonDependencyArchive $assets
    $manifest = New-CustomManifest $assets @((New-ComponentDescriptor "python-deps" "0.2.1" $archive))
    $result = Invoke-TestUpdater $root "--apply" $manifest
    Assert-True ($result.ExitCode -eq 0) "python dependency update failed: $($result.Output)"
    Assert-True ((Get-Content -LiteralPath (Join-Path $root "venv\Lib\site-packages\demo_dep\__init__.py") -Raw) -match "new dependency content") "new Python package was not installed"
    Assert-True ((Read-JsonFile (Join-Path $root "version.json")).components.python_env -eq "0.2.1") "python_env component version was not updated"

    $rollbackRoot = New-TestBundle "python-rollback"
    New-FakePortablePython $rollbackRoot
    Set-Content -LiteralPath (Join-Path $rollbackRoot "venv\fail-install") -Value "fail" -Encoding ASCII
    $rollbackAssets = Join-Path $rollbackRoot "assets"
    New-Item -ItemType Directory -Path $rollbackAssets -Force | Out-Null
    $rollbackArchive = New-PythonDependencyArchive $rollbackAssets
    $rollbackManifest = New-CustomManifest $rollbackAssets @((New-ComponentDescriptor "python-deps" "0.2.1" $rollbackArchive))
    $rollbackResult = Invoke-TestUpdater $rollbackRoot "--apply" $rollbackManifest
    Assert-True ($rollbackResult.ExitCode -ne 0) "failed pip installation unexpectedly succeeded"
    Assert-True ((Get-Content -LiteralPath (Join-Path $rollbackRoot "venv\Lib\site-packages\demo_dep\__init__.py") -Raw) -match "old dependency content") "Python dependency rollback did not restore the old package"
    Assert-True ((Read-JsonFile (Join-Path $rollbackRoot "version.json")).version -eq "0.2.0") "failed Python dependency update changed version.json"
}

function Test-UpdaterSelfUpdate {
    $root = New-TestBundle "self-update"
    $assets = Join-Path $root "assets"
    $sources = Join-Path $root "updater-sources"
    New-Item -ItemType Directory -Path $assets, $sources -Force | Out-Null
    $newVersion = Join-Path $sources "updater.version"
    $newPublicKey = Join-Path $sources "public-key.txt"
    $newMinisign = Join-Path $sources "minisign.exe"
    Set-Content -LiteralPath $newVersion -Value "1.2.0" -Encoding ASCII
    Set-Content -LiteralPath $newPublicKey -Value "new test public key" -Encoding ASCII
    Set-Content -LiteralPath $newMinisign -Value "test minisign binary" -Encoding ASCII
    $updaterInputs = @(
        [pscustomobject]@{ Path = "update.bat"; Source = Join-Path $repoRoot "update.bat" },
        [pscustomobject]@{ Path = "updater/updater.ps1"; Source = Join-Path $repoRoot "updater\updater.ps1" },
        [pscustomobject]@{ Path = "updater/apply-update.ps1"; Source = Join-Path $repoRoot "updater\apply-update.ps1" },
        [pscustomobject]@{ Path = "updater/updater.version"; Source = $newVersion },
        [pscustomobject]@{ Path = "updater/public-key.txt"; Source = $newPublicKey },
        [pscustomobject]@{ Path = "updater/minisign.exe"; Source = $newMinisign },
        [pscustomobject]@{ Path = "updater/README.md"; Source = Join-Path $repoRoot "updater\README.md" }
    )
    $updaterArchive = New-MultiFileComponentArchive $assets "updater.zip" "updater" $updaterInputs
    $appArchive = New-TestArchive $assets "app.zip" "webui/managed.txt" "resumed after self update"
    $components = @(
        (New-ComponentDescriptor "updater" "1.2.0" $updaterArchive),
        (New-ComponentDescriptor "app" "0.2.1" $appArchive)
    )
    $manifest = New-CustomManifest $assets $components "1.2.0"
    $result = Invoke-TestUpdater $root "--apply" $manifest
    Assert-True ($result.ExitCode -eq 0) "updater self-update was not scheduled: $($result.Output)"

    $completed = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        Start-Sleep -Milliseconds 200
        $installedUpdater = (Get-Content -LiteralPath (Join-Path $root "updater\updater.version") -Raw).Trim()
        $managed = Join-Path $root "webui\managed.txt"
        if ($installedUpdater -eq "1.2.0" -and (Test-Path -LiteralPath $managed) -and
            (Get-Content -LiteralPath $managed -Raw) -match "resumed after self update") {
            $completed = $true
            break
        }
    }
    $log = if (Test-Path -LiteralPath (Join-Path $root "_update\update.log")) { Get-Content -LiteralPath (Join-Path $root "_update\update.log") -Raw } else { "" }
    Assert-True $completed "updater self-update did not resume the app update: $log"
    Assert-True ((Read-JsonFile (Join-Path $root "version.json")).components.updater -eq "1.2.0") "version.json did not record the new updater version"
}

function Test-UpgradeMatrixFromSupportedVersions {
    $targetVersion = "0.5.0"
    $cases = @(
        [pscustomobject]@{
            Version = "0.2.0"
            App = "0.2.0"
            CoreCpu = "0.2.0"
            CoreCuda = "0.2.0"
        },
        [pscustomobject]@{
            Version = "0.2.1"
            App = "0.2.1"
            CoreCpu = "0.2.1"
            CoreCuda = "0.2.1"
        },
        [pscustomobject]@{
            Version = "0.2.2"
            App = "0.2.1"
            CoreCpu = "0.2.1"
            CoreCuda = "0.2.2"
        },
        [pscustomobject]@{
            Version = "0.3.0"
            App = "0.3.0"
            CoreCpu = "0.3.0"
            CoreCuda = "0.3.0"
        },
        [pscustomobject]@{
            Version = "0.4.0"
            App = "0.4.0"
            CoreCpu = "0.4.0"
            CoreCuda = "0.4.0"
        },
        [pscustomobject]@{
            Version = "0.4.1"
            App = "0.4.1"
            CoreCpu = "0.4.1"
            CoreCuda = "0.4.1"
        },
        [pscustomobject]@{
            Version = "0.4.2"
            App = "0.4.2"
            CoreCpu = "0.4.2"
            CoreCuda = "0.4.2"
        }
    )

    foreach ($case in $cases) {
        $root = New-TestBundle "upgrade-$($case.Version)" `
            -BundleVersion $case.Version `
            -AppVersion $case.App `
            -CoreCpuVersion $case.CoreCpu `
            -CoreCudaVersion $case.CoreCuda
        New-Item -ItemType Directory -Path (Join-Path $root "models") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $root "models\user-model.bin") -Value "preserve me" -Encoding ASCII

        $assets = Join-Path $root "assets"
        New-Item -ItemType Directory -Path $assets -Force | Out-Null
        $appArchive = New-TestArchive $assets "app-v$targetVersion.zip" "webui\upgrade-matrix.txt" "app $targetVersion" "app"
        $cpuArchive = New-TestArchive $assets "core-cpu-v$targetVersion.zip" "cpu\audiocpp_cli.exe" "cpu $targetVersion" "core-cpu"
        $cudaArchive = New-TestArchive $assets "core-cuda-v$targetVersion.zip" "gpu\audiocpp_cli.exe" "cuda $targetVersion" "core-cuda"
        $components = @(
            (New-ComponentDescriptor "app" $targetVersion $appArchive),
            (New-ComponentDescriptor "core-cpu" $targetVersion $cpuArchive),
            (New-ComponentDescriptor "core-cuda" $targetVersion $cudaArchive)
        )
        $manifest = New-CustomManifest $assets $components `
            -ManifestVersion $targetVersion `
            -SupportedFrom ">=0.2.0"

        $result = Invoke-TestUpdater $root "--apply" $manifest
        Assert-True ($result.ExitCode -eq 0) "upgrade from $($case.Version) failed: $($result.Output)"
        $installed = Read-JsonFile (Join-Path $root "version.json")
        Assert-True ([string]$installed.version -eq $targetVersion) "upgrade from $($case.Version) did not commit target version"
        Assert-True ([string]$installed.components.app -eq $targetVersion) "upgrade from $($case.Version) did not update app"
        Assert-True ([string]$installed.components.core_cpu -eq $targetVersion) "upgrade from $($case.Version) did not update core-cpu"
        Assert-True ([string]$installed.components.core_cuda -eq $targetVersion) "upgrade from $($case.Version) did not update core-cuda"
        Assert-True ((Get-Content -LiteralPath (Join-Path $root "models\user-model.bin") -Raw) -match "preserve me") "upgrade from $($case.Version) changed preserved model data"
    }
}

function Test-ReleaseBuilder {
    $root = Join-Path $testRoot "release-builder"
    $portable = Join-Path $root "portable"
    foreach ($directory in @("cpu", "gpu")) {
        New-Item -ItemType Directory -Path (Join-Path $portable $directory) -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $portable "$directory\audiocpp_cli.exe") -Value "$directory cli" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $portable "$directory\audiocpp_server.exe") -Value "$directory server" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $portable "$directory\audiocpp_gguf.exe") -Value "$directory gguf" -Encoding ASCII
    }
    $secret = Join-Path $root "test-secret.key"
    Set-Content -LiteralPath $secret -Value "test secret" -Encoding ASCII
    $signer = Join-Path $root "test-signer.cmd"
    @(
        "@echo off",
        "if /I `"%~1`"==`"-S`" (",
        "  > `"%~7`" echo VALID_TEST_SIGNATURE",
        "  exit /b 0",
        ")",
        "if /I `"%~1`"==`"-V`" (",
        "  findstr /c:`"VALID_TEST_SIGNATURE`" `"%~5`" >nul 2>nul",
        "  exit /b %errorlevel%",
        ")",
        "exit /b 1"
    ) | Set-Content -LiteralPath $signer -Encoding ASCII
    $publicKey = Join-Path $root "test-public-key.txt"
    Set-Content -LiteralPath $publicKey -Value "test public key" -Encoding ASCII
    $pythonDepsZip = New-PythonDependencyArchive $root "python-source.zip"
    $pythonDepsSource = Join-Path $root "python-source"
    Expand-Archive -LiteralPath $pythonDepsZip -DestinationPath $pythonDepsSource
    Remove-Item -LiteralPath (Join-Path $pythonDepsSource "files.json") -Force
    $output = Join-Path $root "output"
    $releaseNotes = Join-Path $root "custom-release-notes.md"
    Set-Content -LiteralPath $releaseNotes -Value "# Custom release notes" -Encoding UTF8
    $builder = Join-Path $repoRoot "scripts\build_update_release.ps1"
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $builderOutput = @(& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $builder `
        -Version "0.2.1" -PortableRoot $portable -OutputDir $output -MinisignSecretKey $secret `
        -MinisignPublicKey $publicKey -MinisignPath $signer -PythonDepsSource $pythonDepsSource `
        -IncludeUpdater -UpdaterMinisignBinary $signer -ReleaseNotesPath $releaseNotes -Stable -AllowDirty 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    Assert-True ($exitCode -eq 0) "release builder failed: $($builderOutput -join "`n")"
    foreach ($name in @(
        "audiocpp-app-v0.2.1.zip",
        "audiocpp-core-cpu-win-x64-v0.2.1.zip",
        "audiocpp-core-cuda-win-x64-v0.2.1.zip",
        "audiocpp-python-deps-py311-win-x64-v0.2.1.zip",
        "audiocpp-updater-v$testUpdaterVersion.zip",
        "manifest-v0.2.1.json",
        "manifest-v0.2.1.json.minisig",
        "stable.json",
        "SHA256SUMS.txt",
        "SHA256SUMS.txt.minisig",
        "release-notes.md"
    )) {
        Assert-True (Test-Path -LiteralPath (Join-Path $output $name) -PathType Leaf) "release builder did not create $name"
    }
    $manifest = Read-JsonFile (Join-Path $output "manifest-v0.2.1.json")
    Assert-True (@($manifest.components).Count -eq 5) "release manifest does not contain all five component types"
    Assert-True (@($manifest.preserve) -contains "webui/voice/**") "release manifest omitted voice preservation"
    Assert-True ([string]$manifest.supported_from -eq ">=0.2.0") "release manifest does not keep bootstrap installs eligible for later versions"
    Assert-True ((Get-Content -LiteralPath (Join-Path $output "release-notes.md") -Raw) -match "Custom release notes") "release builder did not use custom release notes"
    $appExpanded = Join-Path $root "app-expanded"
    Expand-Archive -LiteralPath (Join-Path $output "audiocpp-app-v0.2.1.zip") -DestinationPath $appExpanded
    foreach ($relative in @(
        "payload\tools\model_manager_v2.py",
        "payload\tools\model_manager_deprecated.py",
        "payload\tools\community_models\convert_glm_tts.py",
        "payload\model_specs\qwen3_asr.json",
        "payload\assets\framework\models\marblenet_vad\marblenet_vad.safetensors",
        "payload\assets\framework\models\marblenet_vad\marblenet_vad_config.json",
        "payload\assets\framework\models\marblenet_vad\marblenet_vad_labels.txt"
    )) {
        Assert-True (Test-Path -LiteralPath (Join-Path $appExpanded $relative) -PathType Leaf) "app ZIP omitted $relative"
    }
    foreach ($directory in @("cpu", "gpu")) {
        $archive = Join-Path $output "audiocpp-core-$($directory -replace 'gpu', 'cuda')-win-x64-v0.2.1.zip"
        $expanded = Join-Path $root "core-$directory-expanded"
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded
        Assert-True (Test-Path -LiteralPath (Join-Path $expanded "payload\$directory\audiocpp_gguf.exe") -PathType Leaf) "core-$directory ZIP omitted audiocpp_gguf.exe"
    }
    $stable = Read-JsonFile (Join-Path $output "stable.json")
    Assert-True ([string]$stable.manifest_url -match '/v0\.2\.1-windows-prebuilt/manifest-v0\.2\.1\.json$') "stable.json points at the wrong manifest"

    $bootstrapPath = Join-Path $root "bootstrap.zip"
    $bootstrapBuilder = Join-Path $repoRoot "scripts\build_updater_bootstrap.ps1"
    $bootstrapOutput = @(& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bootstrapBuilder `
        -Version "0.2.0" -MinisignBinary $signer -PublicKeyPath $publicKey -OutputPath $bootstrapPath 2>&1)
    $bootstrapExitCode = $LASTEXITCODE
    Assert-True ($bootstrapExitCode -eq 0) "bootstrap builder failed: $($bootstrapOutput -join "`n")"
    Assert-True (Test-Path -LiteralPath $bootstrapPath -PathType Leaf) "bootstrap ZIP was not created"
    $bootstrapExpanded = Join-Path $root "bootstrap-expanded"
    Expand-Archive -LiteralPath $bootstrapPath -DestinationPath $bootstrapExpanded
    foreach ($relative in @("update.bat", "version.json", "updater\updater.ps1", "updater\apply-update.ps1", "updater\updater.version", "updater\public-key.txt", "updater\minisign.exe")) {
        Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapExpanded $relative) -PathType Leaf) "bootstrap ZIP omitted $relative"
    }
    $bootstrapVersion = Read-JsonFile (Join-Path $bootstrapExpanded "version.json")
    Assert-True ([string]$bootstrapVersion.components.updater -eq $testUpdaterVersion) "bootstrap version.json does not match updater.version"
}

try {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $tests = @(
        "Test-CheckMode",
        "Test-BatchStableChannelCheck",
        "Test-DryRunAndHashValidation",
        "Test-ApplySuccessAndPreserve",
        "Test-RollbackOnHealthFailure",
        "Test-ProtectedPathAndLock",
        "Test-PythonDependencyUpdateAndRollback",
        "Test-UpdaterSelfUpdate",
        "Test-UpgradeMatrixFromSupportedVersions",
        "Test-ReleaseBuilder"
    )
    foreach ($test in $tests) {
        Write-Host "[RUN ] $test"
        & $test
        Write-Host "[PASS] $test"
    }
    Write-Host "All updater acceptance tests passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
