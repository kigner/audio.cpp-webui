[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Apply,
    [Alias("dry-run")][switch]$DryRun,
    [string]$Manifest = "",
    [string]$StableUrl = "https://github.com/kigner/audio.cpp-webui/releases/latest/download/stable.json",
    [string]$MinisignPath = "",
    [string]$PublicKeyPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:UpdaterDir = $PSScriptRoot
$script:Root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$script:UpdateDir = Join-Path $script:Root "_update"
$script:DownloadsDir = Join-Path $script:UpdateDir "downloads"
$script:StagingDir = Join-Path $script:UpdateDir "staging"
$script:BackupRoot = Join-Path $script:UpdateDir "backup"
$script:LogPath = Join-Path $script:UpdateDir "update.log"
$script:LockPath = Join-Path $script:UpdateDir "update.lock"
$script:ManifestBase = $null
$script:LockStream = $null
$script:Transaction = @()
$script:DependencyTransaction = $null
$script:BackupDir = ""

$script:RequiredPreserve = @(
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

$script:AlwaysProtected = @(
    "models/**",
    "webui/voice/**",
    "webui/output/**",
    "webui/logs/**",
    "webui/llm_api_key.txt",
    "webui/configs/ui_language.json",
    "SpeakType/config.json",
    "SpeakType/logs/**",
    "_update/**",
    "updater/**",
    "version.json"
)

$script:ComponentVersionKeys = @{
    "app" = "app"
    "core-cpu" = "core_cpu"
    "core-cuda" = "core_cuda"
    "python-deps" = "python_env"
    "updater" = "updater"
}

$script:UpdaterManagedPaths = @(
    "update.bat",
    "updater/updater.ps1",
    "updater/apply-update.ps1",
    "updater/updater.version",
    "updater/public-key.txt",
    "updater/minisign.exe",
    "updater/README.md"
)

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $line
    if (Test-Path -LiteralPath $script:UpdateDir) {
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
    }
}

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-IsUnderPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $fullPath = (Get-FullPath $Path).TrimEnd('\')
    $fullParent = (Get-FullPath $Parent).TrimEnd('\')
    return $fullPath.Equals($fullParent, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullParent + "\", [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-SafeRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0) {
        throw "A managed path is empty or invalid."
    }

    $normalized = $Path.Replace('\', '/').Trim()
    if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or $normalized.StartsWith('//')) {
        throw "Absolute paths are not allowed: $Path"
    }

    $parts = $normalized.Split('/')
    if ($parts.Count -eq 0 -or $parts -contains ".." -or $parts -contains "." -or $parts -contains "") {
        throw "Unsafe relative path: $Path"
    }

    $candidate = Get-FullPath (Join-Path $script:Root ($parts -join '\'))
    if (-not (Test-IsUnderPath $candidate $script:Root) -or $candidate -eq $script:Root) {
        throw "Path leaves the portable root: $Path"
    }
    return ($parts -join '/')
}

function Test-PathMatchesRule {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Rule
    )

    $value = $Path.Replace('\', '/').Trim('/').ToLowerInvariant()
    $pattern = $Rule.Replace('\', '/').Trim('/').ToLowerInvariant()
    if ($pattern.EndsWith('/**')) {
        $prefix = $pattern.Substring(0, $pattern.Length - 3)
        return $value -eq $prefix -or $value.StartsWith($prefix + '/')
    }
    return [System.Management.Automation.WildcardPattern]::Get($pattern,
        [System.Management.Automation.WildcardOptions]::IgnoreCase).IsMatch($value)
}

function Assert-ManagedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Preserve
    )

    $safe = ConvertTo-SafeRelativePath $Path
    foreach ($rule in @($script:AlwaysProtected) + @($Preserve)) {
        if (Test-PathMatchesRule $safe ([string]$rule)) {
            throw "Component attempts to modify protected path '$safe' (rule '$rule')."
        }
    }
    return $safe
}

function Assert-UpdaterManagedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $safe = ConvertTo-SafeRelativePath $Path
    if ($script:UpdaterManagedPaths -notcontains $safe) {
        throw "Updater component is not allowed to replace '$safe'."
    }
    return $safe
}

function Assert-PythonPackagePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $safe = ConvertTo-SafeRelativePath $Path
    if ($safe -notmatch '^venv/(Lib/site-packages|Scripts)/[^/].*') {
        throw "Python dependency path must stay under venv/Lib/site-packages or venv/Scripts: $safe"
    }
    return $safe
}

function ConvertTo-Version {
    param([Parameter(Mandatory = $true)][string]$Value)
    $plain = $Value.Trim().TrimStart('v')
    if ($plain.Contains('-')) {
        $plain = $plain.Split('-')[0]
    }
    try {
        return [version]$plain
    } catch {
        throw "Invalid version '$Value'."
    }
}

function Test-VersionRange {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Range
    )

    $current = ConvertTo-Version $Version
    foreach ($clause in ($Range -split '\s+' | Where-Object { $_ -ne "" })) {
        if ($clause -notmatch '^(>=|<=|>|<|=)?(\d+(?:\.\d+){1,3})$') {
            throw "Unsupported version-range clause '$clause'."
        }
        $operator = if ($Matches[1]) { $Matches[1] } else { "=" }
        $target = ConvertTo-Version $Matches[2]
        $comparison = $current.CompareTo($target)
        $matches = switch ($operator) {
            ">=" { $comparison -ge 0 }
            "<=" { $comparison -le 0 }
            ">"  { $comparison -gt 0 }
            "<"  { $comparison -lt 0 }
            "="  { $comparison -eq 0 }
        }
        if (-not $matches) { return $false }
    }
    return $true
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Invalid JSON file '$Path': $($_.Exception.Message)"
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $temp = "$Path.new"
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Initialize-Workspace {
    foreach ($path in @($script:UpdateDir, $script:DownloadsDir, $script:StagingDir, $script:BackupRoot)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Enter-UpdateLock {
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $script:LockStream = [IO.File]::Open($script:LockPath, [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write, [IO.FileShare]::None)
            $bytes = [Text.Encoding]::UTF8.GetBytes("pid=$PID`r`nstarted=$(Get-Date -Format o)`r`n")
            $script:LockStream.Write($bytes, 0, $bytes.Length)
            $script:LockStream.Flush()
            return
        } catch {
            if ($attempt -gt 0 -or -not (Test-Path -LiteralPath $script:LockPath -PathType Leaf)) {
                throw "Another update is running: $script:LockPath"
            }

            $probe = $null
            try {
                $probe = [IO.File]::Open($script:LockPath, [IO.FileMode]::Open,
                    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            } catch {
                throw "Another update is running: $script:LockPath"
            } finally {
                if ($null -ne $probe) { $probe.Dispose() }
            }
            Remove-Item -LiteralPath $script:LockPath -Force
            Write-Log "Removed a stale update lock left by an interrupted run." "WARN"
        }
    }
}

function Exit-UpdateLock {
    if ($null -eq $script:LockStream) { return }
    $script:LockStream.Dispose()
    $script:LockStream = $null
    Remove-Item -LiteralPath $script:LockPath -Force -ErrorAction SilentlyContinue
}

function Reset-StagingDirectory {
    if (-not (Test-IsUnderPath $script:StagingDir $script:UpdateDir)) {
        throw "Refusing to reset an unsafe staging directory."
    }
    if (Test-Path -LiteralPath $script:StagingDir) {
        Remove-Item -LiteralPath $script:StagingDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $script:StagingDir -Force | Out-Null
}

function Copy-OrDownloadFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter()][uri]$BaseUri,
        [Parameter()][string]$BaseDirectory = ""
    )

    $resolvedSource = $Source
    $sourceUri = $null
    if ([uri]::TryCreate($Source, [UriKind]::Absolute, [ref]$sourceUri) -and $sourceUri.Scheme -in @("http", "https", "file")) {
        if ($sourceUri.Scheme -eq "http" -and $sourceUri.Host -notin @("localhost", "127.0.0.1", "::1")) {
            throw "Plain HTTP is only allowed for local acceptance tests: $Source"
        }
        if ($sourceUri.Scheme -eq "file") {
            $resolvedSource = $sourceUri.LocalPath
        } else {
            Write-Log "Downloading $Source"
            Invoke-DownloadFile -Uri $sourceUri.AbsoluteUri -Destination $Destination
            return
        }
    } elseif ($null -ne $BaseUri) {
        $remote = [uri]::new($BaseUri, $Source)
        Write-Log "Downloading $($remote.AbsoluteUri)"
        Invoke-DownloadFile -Uri $remote.AbsoluteUri -Destination $Destination
        return
    } elseif (-not [IO.Path]::IsPathRooted($resolvedSource)) {
        $resolvedSource = Join-Path $BaseDirectory $resolvedSource
    }

    if (-not (Test-Path -LiteralPath $resolvedSource -PathType Leaf)) {
        throw "Local update asset not found: $resolvedSource"
    }
    Copy-Item -LiteralPath $resolvedSource -Destination $Destination -Force
}

function Invoke-DownloadFile {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination,
        [int]$Attempts = 3,
        [int]$TimeoutSeconds = 45
    )

    $temporary = "$Destination.download-$PID"
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $temporary -TimeoutSec $TimeoutSeconds `
                -Headers @{ "User-Agent" = "audio.cpp-portable-updater" }
            Move-Item -LiteralPath $temporary -Destination $Destination -Force
            return
        } catch {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            if ($attempt -ge $Attempts) {
                throw "Download failed after $Attempts attempts: $Uri ($($_.Exception.Message))"
            }
            Start-Sleep -Seconds $attempt
        }
    }
}

function Resolve-PointerAssetSource {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$PointerSource
    )

    $pointerUri = $null
    $pointerIsRemote = [uri]::TryCreate($PointerSource, [UriKind]::Absolute, [ref]$pointerUri) -and
        $pointerUri.Scheme -in @("http", "https")
    $sourceUri = $null
    if ([uri]::TryCreate($Source, [UriKind]::Absolute, [ref]$sourceUri)) {
        if ($sourceUri.Scheme -eq "https" -or
            ($sourceUri.Scheme -eq "http" -and $sourceUri.Host -in @("localhost", "127.0.0.1", "::1"))) {
            return $sourceUri.AbsoluteUri
        }
        if ($sourceUri.Scheme -eq "file" -or [IO.Path]::IsPathRooted($Source)) {
            if ($pointerIsRemote) { throw "A remote stable pointer cannot reference a local asset: $Source" }
            return $(if ($sourceUri.Scheme -eq "file") { $sourceUri.LocalPath } else { Get-FullPath $Source })
        }
        throw "Unsupported stable pointer asset URL: $Source"
    }

    if ($pointerIsRemote) {
        $resolved = [uri]::new($pointerUri, $Source)
        if ($resolved.Scheme -ne "https" -and
            -not ($resolved.Scheme -eq "http" -and $resolved.Host -in @("localhost", "127.0.0.1", "::1"))) {
            throw "The stable manifest and signature must use HTTPS."
        }
        return $resolved.AbsoluteUri
    }

    $pointerPath = Get-FullPath $PointerSource
    return Get-FullPath (Join-Path (Split-Path $pointerPath -Parent) $Source)
}

function Get-SourceBase {
    param([Parameter(Mandatory = $true)][string]$Source)
    $uri = $null
    if ([uri]::TryCreate($Source, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -in @("http", "https")) {
        return $uri
    }
    return Split-Path (Get-FullPath $Source) -Parent
}

function Get-RemoteJson {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    $path = Join-Path $script:DownloadsDir $FileName
    Copy-OrDownloadFile -Source $Source -Destination $path
    return Read-JsonFile $path
}

function Resolve-ManifestFiles {
    $manifestPath = Join-Path $script:DownloadsDir "manifest.json"
    $signaturePath = "$manifestPath.minisig"
    $notesUrl = ""

    if ($Manifest -ne "") {
        $absoluteUri = $null
        if ([uri]::TryCreate($Manifest, [UriKind]::Absolute, [ref]$absoluteUri) -and $absoluteUri.Scheme -in @("http", "https")) {
            if ($absoluteUri.Scheme -eq "http" -and $absoluteUri.Host -notin @("localhost", "127.0.0.1", "::1")) {
                throw "Plain HTTP manifests are only allowed from localhost."
            }
            $script:ManifestBase = $absoluteUri
            Copy-OrDownloadFile -Source $absoluteUri.AbsoluteUri -Destination $manifestPath
            Copy-OrDownloadFile -Source ($absoluteUri.AbsoluteUri + ".minisig") -Destination $signaturePath
        } else {
            $localManifest = Get-FullPath $Manifest
            if (-not (Test-Path -LiteralPath $localManifest -PathType Leaf)) {
                throw "Manifest not found: $localManifest"
            }
            $script:ManifestBase = Split-Path $localManifest -Parent
            if (-not $localManifest.Equals((Get-FullPath $manifestPath), [StringComparison]::OrdinalIgnoreCase)) {
                Copy-Item -LiteralPath $localManifest -Destination $manifestPath -Force
                Copy-Item -LiteralPath ($localManifest + ".minisig") -Destination $signaturePath -Force
            }
        }
    } else {
        $stable = Get-RemoteJson -Source $StableUrl -FileName "stable.json"
        if ([int]$stable.schema -ne 1 -or [string]$stable.channel -ne "stable") {
            throw "stable.json has an unsupported schema or channel."
        }
        if ([string]::IsNullOrWhiteSpace([string]$stable.manifest_url) -or
            [string]::IsNullOrWhiteSpace([string]$stable.signature_url)) {
            throw "stable.json is missing manifest_url or signature_url."
        }
        $manifestSource = Resolve-PointerAssetSource ([string]$stable.manifest_url) $StableUrl
        $signatureSource = Resolve-PointerAssetSource ([string]$stable.signature_url) $StableUrl
        $script:ManifestBase = Get-SourceBase $manifestSource
        Copy-OrDownloadFile -Source $manifestSource -Destination $manifestPath
        Copy-OrDownloadFile -Source $signatureSource -Destination $signaturePath
        if ($null -ne $stable.PSObject.Properties["notes_url"]) {
            $notesUrl = [string]$stable.notes_url
        }
    }

    return [pscustomobject]@{
        ManifestPath = $manifestPath
        SignaturePath = $signaturePath
        NotesUrl = $notesUrl
        PointerVersion = $(if ($Manifest -eq "") { [string]$stable.version } else { "" })
    }
}

function Assert-ManifestSignature {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath
    )

    $tool = if ($MinisignPath -ne "") { Get-FullPath $MinisignPath } else { Join-Path $script:UpdaterDir "minisign.exe" }
    $key = if ($PublicKeyPath -ne "") { Get-FullPath $PublicKeyPath } else { Join-Path $script:UpdaterDir "public-key.txt" }
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "minisign verifier not found: $tool"
    }
    if (-not (Test-Path -LiteralPath $key -PathType Leaf)) {
        throw "minisign public key not found: $key"
    }
    if ((Get-Content -LiteralPath $key -Raw -Encoding UTF8) -match 'REPLACE_WITH_') {
        throw "The updater minisign public key has not been provisioned."
    }

    $output = & $tool -V -m $ManifestPath -x $SignaturePath -p $key 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Manifest signature verification failed: $($output -join ' ')"
    }
    Write-Log "Manifest signature verified."
}

function Assert-Manifest {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)]$LocalVersion
    )

    if ([int]$Value.schema -ne 1) { throw "Unsupported manifest schema." }
    if ([string]$Value.product -ne "audiocpp-portable") { throw "Manifest product mismatch." }
    if ([string]$LocalVersion.product -ne [string]$Value.product) { throw "Local product mismatch." }
    if ($null -ne $Value.PSObject.Properties["platform"] -and
        [string]$Value.platform -ne [string]$LocalVersion.platform) {
        throw "Manifest platform mismatch."
    }
    ConvertTo-Version ([string]$Value.version) | Out-Null
    if ((ConvertTo-Version ([string]$Value.version)) -lt (ConvertTo-Version ([string]$LocalVersion.version))) {
        throw "Refusing to downgrade from $($LocalVersion.version) to $($Value.version)."
    }
    if (-not (Test-VersionRange ([string]$LocalVersion.version) ([string]$Value.supported_from))) {
        throw "Local version $($LocalVersion.version) is outside supported range $($Value.supported_from)."
    }

    $preserve = @($Value.preserve | ForEach-Object { [string]$_ })
    foreach ($required in $script:RequiredPreserve) {
        if ($preserve -notcontains $required) {
            throw "Manifest is missing required preserve rule '$required'."
        }
    }

    if ($null -eq $Value.PSObject.Properties["health_checks"]) {
        throw "Manifest is missing health_checks."
    }

    $seen = @{}
    if (@($Value.components).Count -lt 1) { throw "Manifest contains no components." }
    foreach ($component in @($Value.components)) {
        $id = [string]$component.id
        if (-not $script:ComponentVersionKeys.ContainsKey($id)) {
            throw "Unsupported component id '$id'."
        }
        if ($seen.ContainsKey($id)) { throw "Duplicate component id '$id'." }
        $seen[$id] = $true
        ConvertTo-Version ([string]$component.version) | Out-Null
        if ([string]::IsNullOrWhiteSpace([string]$component.file) -or [int64]$component.size -lt 1) {
            throw "Component '$id' has invalid file metadata."
        }
        if ([string]$component.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "Component '$id' has an invalid SHA-256."
        }
        if (@($component.urls).Count -lt 1) { throw "Component '$id' has no download URL." }
    }

    $updaterVersion = (Get-Content -LiteralPath (Join-Path $script:UpdaterDir "updater.version") -Raw).Trim()
    if ((ConvertTo-Version $updaterVersion) -lt (ConvertTo-Version ([string]$Value.minimum_updater))) {
        $updaterComponent = @($Value.components | Where-Object { [string]$_.id -eq "updater" }) | Select-Object -First 1
        if ($null -eq $updaterComponent -or
            (ConvertTo-Version ([string]$updaterComponent.version)) -lt (ConvertTo-Version ([string]$Value.minimum_updater))) {
            throw "Updater $updaterVersion is older than required version $($Value.minimum_updater), and no suitable updater component is available."
        }
    }
}

function Get-InstalledComponentVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)]$LocalVersion
    )
    if ($Id -eq "updater") {
        return (Get-Content -LiteralPath (Join-Path $script:UpdaterDir "updater.version") -Raw).Trim()
    }
    $key = $script:ComponentVersionKeys[$Id]
    $property = $LocalVersion.components.PSObject.Properties[$key]
    return $(if ($null -eq $property) { "0.0.0" } else { [string]$property.Value })
}

function Get-PendingComponents {
    param(
        [Parameter(Mandatory = $true)]$ManifestValue,
        [Parameter(Mandatory = $true)]$LocalVersion
    )

    $pending = @()
    foreach ($component in @($ManifestValue.components)) {
        $installed = Get-InstalledComponentVersion ([string]$component.id) $LocalVersion
        if ((ConvertTo-Version ([string]$component.version)) -lt (ConvertTo-Version $installed)) {
            throw "Refusing to downgrade component '$($component.id)' from $installed to $($component.version)."
        }
        if ((ConvertTo-Version $installed) -ne (ConvertTo-Version ([string]$component.version))) {
            $pending += $component
        }
    }
    return @($pending)
}

function Show-UpdatePlan {
    param(
        [Parameter(Mandatory = $true)]$LocalVersion,
        [Parameter(Mandatory = $true)]$ManifestValue,
        [Parameter(Mandatory = $true)][object[]]$Pending,
        [string]$NotesUrl = ""
    )

    Write-Host ""
    Write-Host "audio.cpp portable update"
    Write-Host "  Current version : $($LocalVersion.version)"
    Write-Host "  Target version  : $($ManifestValue.version)"
    if ($Pending.Count -eq 0) {
        Write-Host "  Status          : already up to date"
        return
    }
    $bytes = ($Pending | Measure-Object -Property size -Sum).Sum
    Write-Host ("  Download size   : {0:N2} MB" -f ($bytes / 1MB))
    Write-Host "  Components      :"
    foreach ($component in $Pending) {
        Write-Host ("    - {0} -> {1} ({2:N2} MB)" -f $component.id, $component.version, ([int64]$component.size / 1MB))
    }
    if ($NotesUrl -ne "") { Write-Host "  Release notes   : $NotesUrl" }
    Write-Host ""
}

function Resolve-AssetSource {
    param([Parameter(Mandatory = $true)]$Component)

    $sources = @($Component.urls | ForEach-Object { [string]$_ })
    foreach ($source in $sources) {
        $uri = $null
        if ([uri]::TryCreate($source, [UriKind]::Absolute, [ref]$uri) -and
            ($uri.Scheme -eq "https" -or ($uri.Scheme -eq "http" -and $uri.Host -in @("localhost", "127.0.0.1", "::1")))) {
            return $uri.AbsoluteUri
        }
        if ($script:ManifestBase -is [string]) {
            $candidate = if ([IO.Path]::IsPathRooted($source)) { $source } else { Join-Path $script:ManifestBase $source }
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        } else {
            if (-not [uri]::IsWellFormedUriString($source, [UriKind]::Absolute)) {
                return ([uri]::new([uri]$script:ManifestBase, $source)).AbsoluteUri
            }
        }
    }
    throw "No usable source for component '$($Component.id)'."
}

function Get-VerifiedComponentArchive {
    param([Parameter(Mandatory = $true)]$Component)

    $fileName = [IO.Path]::GetFileName([string]$Component.file)
    if ($fileName -ne [string]$Component.file) { throw "Component file must be a base name: $($Component.file)" }
    $destination = Join-Path $script:DownloadsDir $fileName
    $expectedHash = ([string]$Component.sha256).ToLowerInvariant()
    $validCache = $false
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $item = Get-Item -LiteralPath $destination
        if ($item.Length -eq [int64]$Component.size) {
            $validCache = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash
        }
    }
    if (-not $validCache) {
        $source = Resolve-AssetSource $Component
        Copy-OrDownloadFile -Source $source -Destination $destination
    } else {
        Write-Log "Using verified cached asset $fileName"
    }

    $item = Get-Item -LiteralPath $destination
    if ($item.Length -ne [int64]$Component.size) {
        throw "Size mismatch for '$fileName': expected $($Component.size), got $($item.Length)."
    }
    $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 mismatch for '$fileName'."
    }
    Write-Log "Verified component archive $fileName"
    return $destination
}

function Expand-SafeComponentArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][string[]]$Preserve,
        [switch]$UpdaterPayload
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destination = Join-Path $script:StagingDir ([string]$Component.id)
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $archiveObject = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($archiveObject.Entries.Count -gt 20000) { throw "Archive has too many entries." }
        [int64]$expandedBytes = 0
        $archivePaths = @{}
        foreach ($entry in $archiveObject.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.EndsWith('/')) { continue }
            $archiveKey = $name.ToLowerInvariant()
            if ($archivePaths.ContainsKey($archiveKey)) { throw "Duplicate archive entry '$name'." }
            $archivePaths[$archiveKey] = $true
            if ($name -ne "files.json" -and -not $name.StartsWith("payload/")) {
                throw "Unexpected archive entry '$name'."
            }
            $relative = ConvertTo-SafeRelativePath $name
            $expandedBytes += [int64]$entry.Length
            if ($expandedBytes -gt 8GB) { throw "Archive expands beyond the 8 GiB safety limit." }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw "Symbolic links are not allowed in component archives: $name"
            }
            $target = Get-FullPath (Join-Path $destination $relative.Replace('/', '\'))
            if (-not (Test-IsUnderPath $target $destination)) { throw "Archive entry leaves staging: $name" }
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            $sourceStream = $entry.Open()
            try {
                $targetStream = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $sourceStream.CopyTo($targetStream) } finally { $targetStream.Dispose() }
            } finally { $sourceStream.Dispose() }
        }
    } finally { $archiveObject.Dispose() }

    $indexPath = Join-Path $destination "files.json"
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { throw "Component archive has no files.json." }
    $index = Read-JsonFile $indexPath
    if ([int]$index.schema -ne 1 -or [string]$index.component -ne [string]$Component.id) {
        throw "files.json schema or component mismatch for '$($Component.id)'."
    }

    $seen = @{}
    $files = @()
    foreach ($entry in @($index.files)) {
        $path = if ($UpdaterPayload) {
            Assert-UpdaterManagedPath ([string]$entry.path)
        } else {
            Assert-ManagedPath ([string]$entry.path) $Preserve
        }
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { throw "Duplicate managed path '$path'." }
        $seen[$key] = $true
        $source = Join-Path (Join-Path $destination "payload") $path.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Payload file missing: $path" }
        $item = Get-Item -LiteralPath $source
        if ($item.Length -ne [int64]$entry.size) { throw "Payload size mismatch: $path" }
        $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Payload SHA-256 mismatch: $path" }
        $files += [pscustomobject]@{ Path = $path; Source = $source }
    }

    $payloadRoot = Join-Path $destination "payload"
    $payloadFiles = @(Get-ChildItem -LiteralPath $payloadRoot -File -Recurse -ErrorAction SilentlyContinue)
    if ($payloadFiles.Count -ne $files.Count) { throw "Payload contains files not listed in files.json." }
    if ($UpdaterPayload) {
        foreach ($requiredPath in @("update.bat", "updater/updater.ps1", "updater/apply-update.ps1", "updater/updater.version", "updater/public-key.txt", "updater/minisign.exe")) {
            if (-not $seen.ContainsKey($requiredPath.ToLowerInvariant())) {
                throw "Updater component is missing required file '$requiredPath'."
            }
        }
    }

    $remove = @()
    if ($null -ne $index.PSObject.Properties["remove"]) {
        foreach ($pathValue in @($index.remove)) {
            $path = if ($UpdaterPayload) {
                Assert-UpdaterManagedPath ([string]$pathValue)
            } else {
                Assert-ManagedPath ([string]$pathValue) $Preserve
            }
            if ($seen.ContainsKey($path.ToLowerInvariant())) { throw "Path is both installed and removed: $path" }
            $remove += $path
        }
    }

    return [pscustomobject]@{
        Id = [string]$Component.id
        Kind = $(if ($UpdaterPayload) { "updater" } else { "files" })
        Files = $files
        Remove = $remove
    }
}

function ConvertTo-NormalizedPackageName {
    param([Parameter(Mandatory = $true)][string]$Name)
    return ($Name.Trim().ToLowerInvariant() -replace '[-_.]+', '-')
}

function Get-RequirementSpecs {
    param([Parameter(Mandatory = $true)][string]$Path)
    $specs = @()
    $seen = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line -eq "" -or $line.StartsWith('#')) { continue }
        if ($line.EndsWith('\')) { throw "requirements-update.txt must use one complete pinned requirement per line." }
        if ($line.StartsWith('-') -or $line -match '(@|://|;)') {
            throw "Only pinned wheel requirements are allowed: $line"
        }
        $hashes = [regex]::Matches($line, '(?i)--hash=sha256:[0-9a-f]{64}')
        if ($hashes.Count -lt 1) { throw "Requirement has no SHA-256 hash: $line" }
        $base = [regex]::Replace($line, '(?i)\s+--hash=sha256:[0-9a-f]{64}', '').Trim()
        if ($base -notmatch '^([A-Za-z0-9_.-]+)==([^\s]+)$') {
            throw "Requirement must be exactly pinned with ==: $line"
        }
        $name = ConvertTo-NormalizedPackageName $Matches[1]
        $version = $Matches[2]
        if ($name -in @("torch", "torchvision", "torchaudio", "triton") -or
            $name.StartsWith("nvidia-") -or $name.StartsWith("cuda-")) {
            throw "Runtime package '$name' cannot be updated through python-deps."
        }
        if ($seen.ContainsKey($name)) { throw "Duplicate requirement '$name'." }
        $seen[$name] = $true
        $specs += [pscustomobject]@{ Name = $name; Version = $version }
    }
    if ($specs.Count -eq 0) { throw "requirements-update.txt contains no packages." }
    return @($specs)
}

function Expand-PythonDependencyArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)]$Component
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destination = Join-Path $script:StagingDir "python-deps"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $archiveObject = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($archiveObject.Entries.Count -gt 5000) { throw "Python dependency archive has too many entries." }
        [int64]$expandedBytes = 0
        $archivePaths = @{}
        foreach ($entry in $archiveObject.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.EndsWith('/')) { continue }
            $key = $name.ToLowerInvariant()
            if ($archivePaths.ContainsKey($key)) { throw "Duplicate archive entry '$name'." }
            $archivePaths[$key] = $true
            if ($name -notin @("files.json", "requirements-update.txt", "before-install.json", "after-install-checks.json") -and
                $name -notmatch '^wheels/[^/]+\.whl$') {
                throw "Unexpected python-deps archive entry '$name'."
            }
            $relative = ConvertTo-SafeRelativePath $name
            $expandedBytes += [int64]$entry.Length
            if ($expandedBytes -gt 4GB) { throw "Python dependency archive expands beyond 4 GiB." }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw "Symbolic links are not allowed: $name"
            }
            $target = Get-FullPath (Join-Path $destination $relative.Replace('/', '\'))
            if (-not (Test-IsUnderPath $target $destination)) { throw "Archive entry leaves staging: $name" }
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            $sourceStream = $entry.Open()
            try {
                $targetStream = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $sourceStream.CopyTo($targetStream) } finally { $targetStream.Dispose() }
            } finally { $sourceStream.Dispose() }
        }
    } finally { $archiveObject.Dispose() }

    foreach ($required in @("files.json", "requirements-update.txt", "before-install.json", "after-install-checks.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $destination $required) -PathType Leaf)) {
            throw "python-deps archive is missing $required."
        }
    }
    if (@(Get-ChildItem -LiteralPath (Join-Path $destination "wheels") -File -Filter "*.whl" -ErrorAction SilentlyContinue).Count -lt 1) {
        throw "python-deps archive contains no wheels."
    }

    $index = Read-JsonFile (Join-Path $destination "files.json")
    if ([int]$index.schema -ne 1 -or [string]$index.component -ne "python-deps") {
        throw "python-deps files.json is invalid."
    }
    $listed = @{}
    foreach ($entry in @($index.files)) {
        $path = ConvertTo-SafeRelativePath ([string]$entry.path)
        if ($path -eq "files.json" -or $listed.ContainsKey($path.ToLowerInvariant())) {
            throw "Invalid or duplicate python-deps index path '$path'."
        }
        $listed[$path.ToLowerInvariant()] = $true
        $file = Join-Path $destination $path.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Indexed dependency file is missing: $path" }
        if ((Get-Item -LiteralPath $file).Length -ne [int64]$entry.size) { throw "Dependency file size mismatch: $path" }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Dependency file SHA-256 mismatch: $path"
        }
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $destination -File -Recurse | Where-Object { $_.Name -ne "files.json" })
    if ($actualFiles.Count -ne $listed.Count) { throw "python-deps archive contains unindexed files." }

    $requirements = @(Get-RequirementSpecs (Join-Path $destination "requirements-update.txt"))
    $before = Read-JsonFile (Join-Path $destination "before-install.json")
    $after = Read-JsonFile (Join-Path $destination "after-install-checks.json")
    if ([int]$before.schema -ne 1 -or [int]$after.schema -ne 1) { throw "Python dependency plan schema must be 1." }
    if ($null -eq $before.PSObject.Properties["packages"] -or $null -eq $after.PSObject.Properties["packages"]) {
        throw "Python dependency plan must contain packages arrays."
    }

    $afterNames = @{}
    foreach ($package in @($after.packages)) {
        $name = ConvertTo-NormalizedPackageName ([string]$package.name)
        if ($afterNames.ContainsKey($name)) { throw "Duplicate after-install package '$name'." }
        $paths = @($package.paths | ForEach-Object { Assert-PythonPackagePath ([string]$_) })
        if ($paths.Count -lt 1) { throw "After-install package '$name' has no managed paths." }
        $afterNames[$name] = [pscustomobject]@{ Name = $name; Version = [string]$package.version; Paths = $paths }
    }
    foreach ($requirement in $requirements) {
        if (-not $afterNames.ContainsKey($requirement.Name) -or
            [string]$afterNames[$requirement.Name].Version -ne [string]$requirement.Version) {
            throw "after-install-checks.json does not match requirement '$($requirement.Name)==$($requirement.Version)'."
        }
    }

    $beforeNames = @{}
    foreach ($package in @($before.packages)) {
        $name = ConvertTo-NormalizedPackageName ([string]$package.name)
        if ($beforeNames.ContainsKey($name)) { throw "Duplicate before-install package '$name'." }
        $paths = @($package.paths | ForEach-Object { Assert-PythonPackagePath ([string]$_) })
        if ($paths.Count -lt 1) { throw "Before-install package '$name' has no backup paths." }
        $beforeNames[$name] = [pscustomobject]@{ Name = $name; Version = [string]$package.version; Paths = $paths }
    }

    return [pscustomobject]@{
        Id = "python-deps"
        Kind = "python-deps"
        Root = $destination
        RequirementsPath = Join-Path $destination "requirements-update.txt"
        WheelsPath = Join-Path $destination "wheels"
        Requirements = $requirements
        Before = $beforeNames
        After = $afterNames
    }
}

function Get-InstalledPipPackages {
    $python = Join-Path $script:Root "venv\python.exe"
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Portable Python is missing: $python" }
    $stderr = Join-Path $script:StagingDir "pip-list-stderr.txt"
    $output = @(& $python -m pip list --format=json --disable-pip-version-check 2>$stderr)
    if ($LASTEXITCODE -ne 0) {
        $detail = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
        throw "Could not inspect installed Python packages: $detail"
    }
    try { $values = ($output -join "`n") | ConvertFrom-Json } catch { throw "pip list returned invalid JSON." }
    $result = @{}
    foreach ($value in @($values)) {
        $result[(ConvertTo-NormalizedPackageName ([string]$value.name))] = [string]$value.version
    }
    return $result
}

function Assert-PythonDependencyPlan {
    param([Parameter(Mandatory = $true)]$Prepared)
    $installed = Get-InstalledPipPackages
    $beforePaths = @{}
    foreach ($entry in $Prepared.Before.Values) {
        foreach ($path in @($entry.Paths)) { $beforePaths[$path.ToLowerInvariant()] = $true }
    }
    foreach ($requirement in @($Prepared.Requirements)) {
        $installedVersion = if ($installed.ContainsKey($requirement.Name)) { [string]$installed[$requirement.Name] } else { "" }
        if ($installedVersion -ne "" -and $installedVersion -ne [string]$requirement.Version) {
            if (-not $Prepared.Before.ContainsKey($requirement.Name) -or
                [string]$Prepared.Before[$requirement.Name].Version -ne $installedVersion) {
                throw "Upgrade of '$($requirement.Name)' from $installedVersion requires matching before-install backup metadata."
            }
        }
        foreach ($path in @($Prepared.After[$requirement.Name].Paths)) {
            $existing = Join-Path $script:Root $path.Replace('/', '\')
            if ((Test-Path -LiteralPath $existing) -and -not $beforePaths.ContainsKey($path.ToLowerInvariant())) {
                throw "Existing Python path '$path' must be listed in before-install.json before replacement."
            }
        }
    }
    $Prepared | Add-Member -NotePropertyName InstalledBefore -NotePropertyValue $installed -Force
}

function Backup-PythonDependencies {
    param([Parameter(Mandatory = $true)]$Prepared)
    $backupEntries = @()
    foreach ($entry in $Prepared.Before.Values) {
        foreach ($path in @($entry.Paths)) {
            $source = Join-Path $script:Root $path.Replace('/', '\')
            if (-not (Test-Path -LiteralPath $source)) { continue }
            $backup = Join-Path (Join-Path $script:BackupDir "python") $path.Replace('/', '\')
            New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $backup -Recurse -Force
            $backupEntries += [pscustomobject]@{ Path = $path; Backup = $backup }
        }
    }
    $afterPaths = @($Prepared.After.Values | ForEach-Object { @($_.Paths) } | ForEach-Object { $_ } | Select-Object -Unique)
    $script:DependencyTransaction = [pscustomobject]@{ Before = $backupEntries; After = $afterPaths }
    Write-TransactionLog
}

function Install-PythonDependencies {
    param([Parameter(Mandatory = $true)]$Prepared)
    Backup-PythonDependencies $Prepared
    $python = Join-Path $script:Root "venv\python.exe"
    Invoke-ProcessHealthCheck $python @(
        "-m", "pip", "install",
        "--disable-pip-version-check",
        "--no-index",
        "--find-links", $Prepared.WheelsPath,
        "--require-hashes",
        "--only-binary=:all:",
        "-r", $Prepared.RequirementsPath
    ) 300
    Invoke-ProcessHealthCheck $python @("-m", "pip", "check") 120
    $installed = Get-InstalledPipPackages
    foreach ($requirement in @($Prepared.Requirements)) {
        if (-not $installed.ContainsKey($requirement.Name) -or
            [string]$installed[$requirement.Name] -ne [string]$requirement.Version) {
            throw "Python dependency verification failed for '$($requirement.Name)==$($requirement.Version)'."
        }
    }
}

function Restore-PythonDependencies {
    if ($null -eq $script:DependencyTransaction) { return }
    Write-Log "Rolling back Python dependency paths." "WARN"
    foreach ($path in @($script:DependencyTransaction.After)) {
        $safe = Assert-PythonPackagePath ([string]$path)
        $destination = Join-Path $script:Root $safe.Replace('/', '\')
        Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($entry in @($script:DependencyTransaction.Before)) {
        $destination = Join-Path $script:Root ([string]$entry.Path).Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath ([string]$entry.Backup) -Destination $destination -Recurse -Force
    }
}

function Assert-NoRunningPortableProcesses {
    $blocking = @()
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        if ($process.Id -eq $PID) { continue }
        $name = $process.ProcessName.ToLowerInvariant()
        if ($name -notin @("audiocpp_cli", "audiocpp_server", "python", "pythonw")) { continue }
        $path = ""
        try { $path = [string]$process.Path } catch { }
        if (($path -ne "" -and (Test-IsUnderPath $path $script:Root)) -or
            ($path -eq "" -and $name -in @("audiocpp_cli", "audiocpp_server"))) {
            $blocking += "$($process.ProcessName) (PID $($process.Id))"
        }
    }
    if ($blocking.Count -gt 0) {
        throw "Close these portable processes before updating: $($blocking -join ', ')"
    }
}

function Write-TransactionLog {
    $value = [ordered]@{
        root = $script:Root
        backup = $script:BackupDir
        operations = @($script:Transaction)
        python = $script:DependencyTransaction
    }
    Write-JsonAtomic $value (Join-Path $script:BackupDir "transaction.json")
}

function Backup-PathForOperation {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    return Join-Path (Join-Path $script:BackupDir "files") $RelativePath.Replace('/', '\')
}

function Install-UpdateFiles {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$PreparedComponents)

    $allPaths = @{}
    foreach ($prepared in $PreparedComponents) {
        foreach ($file in @($prepared.Files)) {
            $key = $file.Path.ToLowerInvariant()
            if ($allPaths.ContainsKey($key)) { throw "Multiple components manage '$($file.Path)'." }
            $allPaths[$key] = $true
        }
        foreach ($path in @($prepared.Remove)) {
            $key = $path.ToLowerInvariant()
            if ($allPaths.ContainsKey($key)) { throw "Multiple component operations target '$path'." }
            $allPaths[$key] = $true
        }
    }

    foreach ($prepared in $PreparedComponents) {
        foreach ($file in @($prepared.Files)) {
            $destination = Join-Path $script:Root $file.Path.Replace('/', '\')
            $exists = Test-Path -LiteralPath $destination -PathType Leaf
            if ($exists) {
                $backup = Backup-PathForOperation $file.Path
                New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
                Copy-Item -LiteralPath $destination -Destination $backup -Force
            }
            $operation = [ordered]@{ path = $file.Path; action = $(if ($exists) { "replace" } else { "create" }) }
            $script:Transaction += $operation
            Write-TransactionLog

            New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
            $temp = "$destination.update-new-$PID"
            Copy-Item -LiteralPath $file.Source -Destination $temp -Force
            Move-Item -LiteralPath $temp -Destination $destination -Force
        }

        foreach ($path in @($prepared.Remove)) {
            $destination = Join-Path $script:Root $path.Replace('/', '\')
            if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { continue }
            $backup = Backup-PathForOperation $path
            New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $destination -Destination $backup -Force
            $script:Transaction += [ordered]@{ path = $path; action = "remove" }
            Write-TransactionLog
            Remove-Item -LiteralPath $destination -Force
        }
    }
}

function Restore-UpdateFiles {
    Write-Log "Rolling back $($script:Transaction.Count) file operations." "WARN"
    for ($index = $script:Transaction.Count - 1; $index -ge 0; $index--) {
        $operation = $script:Transaction[$index]
        $destination = Join-Path $script:Root ([string]$operation.path).Replace('/', '\')
        if ([string]$operation.action -eq "create") {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
            continue
        }
        $backup = Backup-PathForOperation ([string]$operation.path)
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            throw "Rollback backup is missing: $backup"
        }
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $backup -Destination $destination -Force
    }
}

function Start-UpdaterSelfUpdate {
    param(
        [Parameter(Mandatory = $true)]$Prepared,
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )
    if (@($Prepared.Remove).Count -gt 0) { throw "Updater self-update does not support remove operations." }
    $helperSource = Join-Path $script:UpdaterDir "apply-update.ps1"
    if (-not (Test-Path -LiteralPath $helperSource -PathType Leaf)) { throw "Updater self-update helper is missing." }
    $helperCopy = Join-Path $script:UpdateDir "apply-updater.ps1"
    Copy-Item -LiteralPath $helperSource -Destination $helperCopy -Force
    $currentPublicKey = if ($PublicKeyPath -ne "") { Get-FullPath $PublicKeyPath } else { Join-Path $script:UpdaterDir "public-key.txt" }
    $resumePublicKey = Join-Path $script:UpdateDir "self-update-public-key.txt"
    Copy-Item -LiteralPath $currentPublicKey -Destination $resumePublicKey -Force
    $backup = Join-Path $script:BackupRoot ("updater-{0}-{1}" -f ((Get-Content (Join-Path $script:UpdaterDir "updater.version") -Raw).Trim()), (Get-Date -Format "yyyyMMdd-HHmmss"))
    $configPath = Join-Path $script:UpdateDir "apply-updater.json"
    $config = [ordered]@{
        root = $script:Root
        parent_pid = $PID
        version = [string]$Component.version
        manifest = $ManifestPath
        backup = $backup
        minisign_path = $MinisignPath
        public_key_path = $resumePublicKey
        files = @($Prepared.Files | ForEach-Object { [ordered]@{ path = $_.Path; source = $_.Source } })
    }
    Write-JsonAtomic $config $configPath
    $argumentLine = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$helperCopy`" -ConfigPath `"$configPath`""
    Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -WorkingDirectory $script:Root -WindowStyle Hidden | Out-Null
    Write-Log "Updater $($Component.version) self-update is scheduled; it will resume this update automatically."
}

function Invoke-ProcessHealthCheck {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 45
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Health-check executable missing: $FilePath" }
    $argumentLine = @($Arguments | ForEach-Object {
        $argument = [string]$_
        if ($argument -match '[\s"]') { '"' + $argument.Replace('"', '\"') + '"' } else { $argument }
    }) -join ' '
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $argumentLine
    $startInfo.WorkingDirectory = $script:Root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start health check: $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch { }
        throw "Health check timed out: $FilePath $($Arguments -join ' ')"
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($process.ExitCode -ne 0) {
        throw "Health check failed ($($process.ExitCode)): $FilePath $($Arguments -join ' ') $stdout $stderr"
    }
}

function Invoke-HealthChecks {
    param([Parameter(Mandatory = $true)]$ManifestValue)

    foreach ($checkName in @($ManifestValue.health_checks | ForEach-Object { [string]$_ })) {
        Write-Log "Running health check '$checkName'"
        switch ($checkName) {
            "cpu-cli-help" { Invoke-ProcessHealthCheck (Join-Path $script:Root "cpu\audiocpp_cli.exe") @("--help") }
            "cpu-server-help" { Invoke-ProcessHealthCheck (Join-Path $script:Root "cpu\audiocpp_server.exe") @("--help") }
            "cuda-cli-help-if-available" {
                $path = Join-Path $script:Root "gpu\audiocpp_cli.exe"
                if (Test-Path -LiteralPath $path) { Invoke-ProcessHealthCheck $path @("--help") }
            }
            "cuda-server-help-if-available" {
                $path = Join-Path $script:Root "gpu\audiocpp_server.exe"
                if (Test-Path -LiteralPath $path) { Invoke-ProcessHealthCheck $path @("--help") }
            }
            "pip-check" {
                Invoke-ProcessHealthCheck (Join-Path $script:Root "venv\python.exe") @("-m", "pip", "check") 120
            }
            "python-compile" {
                Invoke-ProcessHealthCheck (Join-Path $script:Root "venv\python.exe") @("-m", "compileall", "-q", "webui", "SpeakType") 180
            }
            "python-imports" {
                $imports = if ($null -ne $ManifestValue.PSObject.Properties["required_python_imports"]) {
                    @($ManifestValue.required_python_imports | ForEach-Object { [string]$_ })
                } else { @("gradio", "fastapi", "uvicorn") }
                $code = ($imports | ForEach-Object { "import $_" }) -join "; "
                Invoke-ProcessHealthCheck (Join-Path $script:Root "venv\python.exe") @("-c", $code) 90
            }
            default { throw "Unsupported health check '$checkName'." }
        }
    }
}

function New-InstalledVersion {
    param(
        [Parameter(Mandatory = $true)]$LocalVersion,
        [Parameter(Mandatory = $true)]$ManifestValue,
        [Parameter(Mandatory = $true)][object[]]$Pending
    )

    $components = [ordered]@{}
    foreach ($property in $LocalVersion.components.PSObject.Properties) {
        $components[$property.Name] = [string]$property.Value
    }
    foreach ($component in $Pending) {
        $components[$script:ComponentVersionKeys[[string]$component.id]] = [string]$component.version
    }
    $components["updater"] = (Get-Content -LiteralPath (Join-Path $script:UpdaterDir "updater.version") -Raw).Trim()
    return [ordered]@{
        product = [string]$LocalVersion.product
        version = [string]$ManifestValue.version
        channel = [string]$LocalVersion.channel
        platform = [string]$LocalVersion.platform
        python = [string]$LocalVersion.python
        components = $components
    }
}

function Remove-OlderBackups {
    param([Parameter(Mandatory = $true)][string]$Keep)
    foreach ($directory in Get-ChildItem -LiteralPath $script:BackupRoot -Directory -ErrorAction SilentlyContinue) {
        if (-not $directory.FullName.Equals($Keep, [StringComparison]::OrdinalIgnoreCase) -and
            (Test-IsUnderPath $directory.FullName $script:BackupRoot)) {
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        }
    }
}

function Invoke-Main {
    $modeCount = @(@([bool]$Check, [bool]$Apply, [bool]$DryRun) | Where-Object { $_ }).Count
    if ($modeCount -gt 1) { throw "Use only one of --check, --apply, or --dry-run." }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Initialize-Workspace
    Enter-UpdateLock

    $versionPath = Join-Path $script:Root "version.json"
    if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { throw "Missing local version.json." }
    $localVersion = Read-JsonFile $versionPath
    Reset-StagingDirectory

    $resolved = Resolve-ManifestFiles
    Assert-ManifestSignature $resolved.ManifestPath $resolved.SignaturePath
    $manifestValue = Read-JsonFile $resolved.ManifestPath
    Assert-Manifest $manifestValue $localVersion
    if ($resolved.PointerVersion -ne "" -and $resolved.PointerVersion -ne [string]$manifestValue.version) {
        throw "stable.json version does not match the signed manifest version."
    }
    $pending = @(Get-PendingComponents $manifestValue $localVersion)
    Show-UpdatePlan $localVersion $manifestValue $pending $resolved.NotesUrl
    if ($pending.Count -eq 0 -or $Check) { return }

    $doApply = [bool]$Apply
    if (-not $Apply -and -not $DryRun) {
        $answer = Read-Host "Apply this update? [y/N]"
        if ($answer -notin @("y", "Y", "yes", "YES")) {
            Write-Log "Update cancelled by user."
            return
        }
        $doApply = $true
    }

    if ($doApply) { Assert-NoRunningPortableProcesses }
    $prepared = @()
    $preserve = @($manifestValue.preserve | ForEach-Object { [string]$_ })
    foreach ($component in $pending) {
        $archive = Get-VerifiedComponentArchive $component
        switch ([string]$component.id) {
            "python-deps" { $prepared += Expand-PythonDependencyArchive $archive $component }
            "updater" { $prepared += Expand-SafeComponentArchive $archive $component $preserve -UpdaterPayload }
            default { $prepared += Expand-SafeComponentArchive $archive $component $preserve }
        }
    }
    foreach ($dependency in @($prepared | Where-Object { $_.Kind -eq "python-deps" })) {
        Assert-PythonDependencyPlan $dependency
    }

    if ($DryRun) {
        Write-Log "Dry run completed. All selected assets, hashes, indexes, and managed paths are valid."
        return
    }

    $preparedUpdater = @($prepared | Where-Object { $_.Kind -eq "updater" }) | Select-Object -First 1
    if ($null -ne $preparedUpdater) {
        $updaterComponent = @($pending | Where-Object { [string]$_.id -eq "updater" }) | Select-Object -First 1
        Start-UpdaterSelfUpdate $preparedUpdater $updaterComponent $resolved.ManifestPath
        return
    }

    $backupName = "{0}-{1}" -f ([string]$localVersion.version), (Get-Date -Format "yyyyMMdd-HHmmss")
    $script:BackupDir = Join-Path $script:BackupRoot $backupName
    New-Item -ItemType Directory -Path $script:BackupDir -Force | Out-Null
    try {
        foreach ($dependency in @($prepared | Where-Object { $_.Kind -eq "python-deps" })) {
            Install-PythonDependencies $dependency
        }
        Install-UpdateFiles @($prepared | Where-Object { $_.Kind -eq "files" })
        Invoke-HealthChecks $manifestValue
        $installedVersion = New-InstalledVersion $localVersion $manifestValue $pending
        Write-JsonAtomic $installedVersion $versionPath
    } catch {
        $failure = $_
        try { Restore-UpdateFiles } catch { Write-Log "Rollback also failed: $($_.Exception.Message)" "ERROR" }
        try { Restore-PythonDependencies } catch { Write-Log "Python dependency rollback also failed: $($_.Exception.Message)" "ERROR" }
        throw $failure
    }
    try { Remove-OlderBackups $script:BackupDir } catch { Write-Log "Could not remove an older backup: $($_.Exception.Message)" "WARN" }
    Write-Log "Update to $($manifestValue.version) completed successfully."
}

try {
    Invoke-Main
    exit 0
} catch {
    Write-Log $_.Exception.Message "ERROR"
    exit 1
} finally {
    Exit-UpdateLock
}
