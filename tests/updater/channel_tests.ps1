function Test-DefaultChannelSources {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot 'updater/updater.ps1'), [ref]$tokens, [ref]$errors)
    foreach ($name in @('Get-StableSources', 'ConvertTo-Version')) {
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $StableUrl = ''; $StableUrls = @(); $script:UpdateBaseline = '0.7.0'
    $legacy = @(Get-StableSources ([pscustomobject]@{ version = '0.6.0' }))
    Assert-True ($legacy.Count -eq 1 -and $legacy[0] -eq 'https://github.com/kigner/audio.cpp-webui/releases/latest/download/stable.json') 'legacy channel changed'
    $modern = @(Get-StableSources ([pscustomobject]@{ version = '0.7.0' }))
    Assert-True ($modern.Count -eq 3) 'new baseline requires three feeds'
    Assert-True ($modern[0] -eq 'https://github.com/kigner/audio.cpp-webui/releases/latest/download/stable-v0.7.0.json') 'new GitHub channel is not isolated'
    Assert-True ($modern[1] -eq 'https://huggingface.co/kigner/audio.cpp-webui/resolve/main/updates/v0.7.0/stable.json') 'HF channel path is wrong'
    Assert-True ($modern[2] -eq 'https://hf-mirror.com/kigner/audio.cpp-webui/resolve/main/updates/v0.7.0/stable.json') 'mirror channel path is wrong'
}

function Test-BaselineBoundaryAndVulkan {
    $initial = New-TestBundle 'initial-full-baseline' -BundleVersion '0.7.0'
    $initialAssets = Join-Path $initial 'assets'
    New-Item -ItemType Directory -Path $initialAssets -Force | Out-Null
    $initialArchive = New-TestArchive $initialAssets 'app.zip' 'webui/managed.txt'
    $initialManifest = New-CustomManifest $initialAssets @((New-ComponentDescriptor 'app' '0.7.0' $initialArchive)) -ManifestVersion '0.7.0' -SupportedFrom '>=0.7.0'
    $initialResult = Invoke-TestUpdater $initial '--apply' $initialManifest
    Assert-True ($initialResult.ExitCode -eq 0 -and $initialResult.Output -match 'already up to date') "initial full baseline did not report up to date: $($initialResult.Output)"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $initial 'webui/managed.txt'))) 'initial baseline unnecessarily installed app payload'
    foreach ($localVersion in @('0.2.0', '0.6.0', '0.7.0', '0.7.1')) {
        $root = New-TestBundle "baseline-$localVersion" -BundleVersion $localVersion
        $assets = Join-Path $root 'assets'
        New-Item -ItemType Directory -Path $assets -Force | Out-Null
        $archive = New-TestArchive $assets 'vulkan.zip' 'vulkan/runtime.dll' 'new Vulkan runtime' 'core-vulkan'
        $manifest = New-CustomManifest $assets @((New-ComponentDescriptor 'core-vulkan' '0.7.2' $archive)) `
            -ManifestVersion '0.7.2' -SupportedFrom '>=0.2.0'
        # Even an accidentally broad signed supported_from must not cross the baseline.
        $result = Invoke-TestUpdater $root '--apply' $manifest
        $installed = Read-JsonFile (Join-Path $root 'version.json')
        if ([version]$localVersion -lt [version]'0.7.0') {
            Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'Aixora-Studio.zip') 'old installation crossed baseline'
            Assert-True ($installed.version -eq $localVersion) 'rejected update changed version'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'vulkan/runtime.dll'))) 'rejected update installed files'
        } else {
            Assert-True ($result.ExitCode -eq 0) "Vulkan upgrade failed: $($result.Output)"
            Assert-True ($installed.version -eq '0.7.2' -and $installed.components.core_vulkan -eq '0.7.2') 'Vulkan version was not recorded'
            Assert-True ((Get-Content -LiteralPath (Join-Path $root 'vulkan/runtime.dll') -Raw) -match 'new Vulkan runtime') 'Vulkan payload missing'
        }
    }
    $root = New-TestBundle 'foreign-baseline' -BundleVersion '0.7.0'
    $assets = Join-Path $root 'assets'
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    $archive = New-TestArchive $assets 'app.zip' 'webui/managed.txt'
    $manifest = New-CustomManifest $assets @((New-ComponentDescriptor 'app' '0.8.1' $archive)) -ManifestVersion '0.8.1' -SupportedFrom '>=0.7.0'
    $value = Read-JsonFile $manifest
    $value.update_baseline = '0.8.0'
    Write-Json $value $manifest
    $result = Invoke-TestUpdater $root '--apply' $manifest
    Assert-True ($result.ExitCode -ne 0 -and $result.Output -match 'does not belong to update baseline') 'foreign baseline was accepted'
}

function Invoke-TestFeedUpdate {
    param([string]$Root, [string[]]$Sources)
    $runner = Join-Path $Root 'test-feed.ps1'
    $quoted = @($Sources | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ','
    $body = @"
& (Join-Path `$PSScriptRoot 'updater/updater.ps1') -Apply -StableUrls @($quoted) -MinisignPath (Join-Path `$PSScriptRoot 'updater/test-minisign.cmd') -PublicKeyPath (Join-Path `$PSScriptRoot 'updater/test-public-key.txt')
exit `$LASTEXITCODE
"@
    Set-Content -LiteralPath $runner -Value $body -Encoding UTF8
    $output = @(& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1)
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Test-HttpFallbackAndValidation {
    $httpRoot = Join-Path $testRoot 'http-assets'
    $release = Join-Path $httpRoot 'release'
    New-Item -ItemType Directory -Path $release, (Join-Path $httpRoot 'primary'), (Join-Path $httpRoot 'mirror') -Force | Out-Null
    $ready = Join-Path $testRoot 'http-ready.json'
    $python = Join-Path $repoRoot 'venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python)) { $python = (Get-Command python -ErrorAction Stop).Source }
    $serverScript = Join-Path $PSScriptRoot 'http_fixture.py'
    $server = Start-Process -FilePath $python -ArgumentList "-B `"$serverScript`" `"$httpRoot`" `"$ready`"" -WindowStyle Hidden -PassThru
    try {
        for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $ready); $attempt++) { Start-Sleep -Milliseconds 100 }
        Assert-True (Test-Path -LiteralPath $ready) 'HTTP fixture did not start'
        $base = 'http://127.0.0.1:' + (Read-JsonFile $ready).port
        $archive = New-TestArchive $release 'app.zip' 'webui/managed.txt' 'HTTP backup installed'
        $corrupt = [IO.File]::ReadAllBytes($archive)
        $corrupt[0] = $corrupt[0] -bxor 255
        [IO.File]::WriteAllBytes((Join-Path $release 'corrupt.zip'), $corrupt)
        Set-Content -LiteralPath (Join-Path $release 'short.zip') -Value 'truncated' -Encoding ASCII
        $component = New-ComponentDescriptor 'app' '0.7.1' $archive
        $component.urls = @("$base/release/missing.zip", "$base/release/short.zip", "$base/release/corrupt.zip", "$base/release/app.zip")
        $manifest = New-CustomManifest $release @($component) -ManifestVersion '0.7.1' -SupportedFrom '>=0.7.0'
        Set-Content -LiteralPath (Join-Path $httpRoot 'primary/invalid.minisig') -Value 'INVALID' -Encoding ASCII
        $pointer = [ordered]@{ schema = 1; channel = 'stable'; version = '0.7.1'; manifest_url = '../release/manifest-custom.json'; signature_url = 'invalid.minisig' }
        Write-Json $pointer (Join-Path $httpRoot 'primary/stable.json')
        $pointer.signature_url = '../release/manifest-custom.json.minisig'
        Write-Json $pointer (Join-Path $httpRoot 'mirror/stable.json')
        $root = New-TestBundle 'http-backup-install' -BundleVersion '0.7.0'
        $result = Invoke-TestFeedUpdate $root @("$base/primary/stable.json", "$base/unavailable/stable.json", "$base/mirror/stable.json")
        Assert-True ($result.ExitCode -eq 0) "HTTP fallback failed: $($result.Output)"
        Assert-True ($result.Output -match 'Manifest signature verification failed') 'bad primary signature was not rejected'
        Assert-True ($result.Output -match 'Size mismatch' -and $result.Output -match 'SHA-256 mismatch') 'bad component sources bypassed validation'
        Assert-True ((Get-Content -LiteralPath (Join-Path $root 'webui/managed.txt') -Raw) -match 'HTTP backup installed') 'backup payload was not installed'
        Assert-True ((Read-JsonFile (Join-Path $root 'version.json')).version -eq '0.7.1') 'backup update did not finish'
        $requests = Get-Content -LiteralPath (Join-Path $httpRoot 'requests.log') -Raw
        Assert-True ($requests -match '/unavailable/stable.json' -and $requests -match '/mirror/stable.json') 'third feed was not used'
        $failedRoot = New-TestBundle 'http-all-invalid' -BundleVersion '0.7.0'
        $failed = Invoke-TestFeedUpdate $failedRoot @("$base/primary/stable.json", "$base/unavailable/stable.json")
        Assert-True ($failed.ExitCode -ne 0 -and $failed.Output -match 'No valid update source') 'all-invalid feeds were accepted'
        Assert-True ((Read-JsonFile (Join-Path $failedRoot 'version.json')).version -eq '0.7.0') 'failed feeds changed installation'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $failedRoot 'webui/managed.txt'))) 'failed feeds installed payload'
    } finally {
        if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
        $server.Dispose()
    }
}
