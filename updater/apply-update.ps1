[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-HelperLog {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] [self-update] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Test-IsUnderPath {
    param([string]$Path, [string]$Parent)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $fullPath.StartsWith($fullParent + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-NewUpdater {
    param([string]$Mode)
    $arguments = @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $script:Root "updater\updater.ps1"),
        $Mode, "--manifest", [string]$script:Config.manifest
    )
    if ([string]$script:Config.minisign_path -ne "") {
        $arguments += @("-MinisignPath", [string]$script:Config.minisign_path)
    }
    if ([string]$script:Config.public_key_path -ne "") {
        $arguments += @("-PublicKeyPath", [string]$script:Config.public_key_path)
    }
    $output = @(& powershell.exe @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) { Write-HelperLog ([string]$line) }
    return [int]$exitCode
}

$script:Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$script:Root = [IO.Path]::GetFullPath([string]$script:Config.root)
$script:LogPath = Join-Path $script:Root "_update\update.log"
$backupRoot = [IO.Path]::GetFullPath([string]$script:Config.backup)
$allowed = @(
    "update.bat",
    "updater/updater.ps1",
    "updater/apply-update.ps1",
    "updater/updater.version",
    "updater/public-key.txt",
    "updater/minisign.exe",
    "updater/README.md"
)
$operations = @()

try {
    try { Wait-Process -Id ([int]$script:Config.parent_pid) -ErrorAction SilentlyContinue } catch { }
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Write-HelperLog "Installing updater $($script:Config.version)."

    foreach ($file in @($script:Config.files)) {
        $relative = ([string]$file.path).Replace('\', '/').Trim('/')
        if ($allowed -notcontains $relative) { throw "Disallowed updater path: $relative" }
        $source = [IO.Path]::GetFullPath([string]$file.source)
        $destination = [IO.Path]::GetFullPath((Join-Path $script:Root $relative.Replace('/', '\')))
        if (-not (Test-IsUnderPath $destination $script:Root) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Unsafe or missing updater file: $relative"
        }
        $exists = Test-Path -LiteralPath $destination -PathType Leaf
        if ($exists) {
            $backup = Join-Path $backupRoot $relative.Replace('/', '\')
            New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $destination -Destination $backup -Force
        }
        $operations += [pscustomobject]@{ Path = $relative; Existed = $exists }
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        $temp = "$destination.self-update-new"
        Copy-Item -LiteralPath $source -Destination $temp -Force
        Move-Item -LiteralPath $temp -Destination $destination -Force
    }

    $checkExit = Invoke-NewUpdater "--check"
    if ($checkExit -ne 0) { throw "New updater failed its manifest check with exit code $checkExit." }

    $versionPath = Join-Path $script:Root "version.json"
    $versionValue = Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $versionValue.components.PSObject.Properties["updater"]) {
        $versionValue.components | Add-Member -NotePropertyName "updater" -NotePropertyValue ([string]$script:Config.version)
    } else {
        $versionValue.components.updater = [string]$script:Config.version
    }
    $versionValue | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath "$versionPath.new" -Encoding UTF8
    Move-Item -LiteralPath "$versionPath.new" -Destination $versionPath -Force
    Write-HelperLog "Updater self-check passed; resuming the requested update."

    $applyExit = Invoke-NewUpdater "--apply"
    if ($applyExit -ne 0) {
        Write-HelperLog "The resumed update failed with exit code $applyExit; the new updater remains installed." "ERROR"
        exit $applyExit
    }
    Write-HelperLog "Updater self-update and resumed update completed."
    Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
    exit 0
} catch {
    Write-HelperLog "Updater self-update failed: $($_.Exception.Message). Rolling back updater files." "ERROR"
    for ($index = $operations.Count - 1; $index -ge 0; $index--) {
        $operation = $operations[$index]
        $destination = Join-Path $script:Root ([string]$operation.Path).Replace('/', '\')
        if (-not [bool]$operation.Existed) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        } else {
            $backup = Join-Path $backupRoot ([string]$operation.Path).Replace('/', '\')
            if (Test-Path -LiteralPath $backup -PathType Leaf) {
                Copy-Item -LiteralPath $backup -Destination $destination -Force
            }
        }
    }
    exit 1
}
