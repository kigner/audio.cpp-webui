[CmdletBinding()]
param(
    [string]$Version = "0.2.0",
    [Parameter(Mandatory = $true)][string]$MinisignBinary,
    [Parameter(Mandatory = $true)][string]$PublicKeyPath,
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$MinisignBinary = [IO.Path]::GetFullPath($MinisignBinary)
$PublicKeyPath = [IO.Path]::GetFullPath($PublicKeyPath)
if ($OutputPath -eq "") {
    $OutputPath = Join-Path $repoRoot "dist\bootstrap\audiocpp-online-update-bootstrap-v$Version.zip"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

if (-not (Test-Path -LiteralPath $MinisignBinary -PathType Leaf)) {
    throw "minisign.exe not found: $MinisignBinary"
}
if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
    throw "Minisign public key not found: $PublicKeyPath"
}
if ((Get-Content -LiteralPath $PublicKeyPath -Raw -Encoding UTF8) -match 'REPLACE_WITH_') {
    throw "Refusing to package a placeholder minisign public key."
}

$outputDirectory = Split-Path $OutputPath -Parent
$stage = Join-Path $outputDirectory ".bootstrap-staging"
if ($stage -eq $repoRoot -or $stage.Length -lt 4) { throw "Unsafe bootstrap staging path." }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage "updater") -Force | Out-Null

try {
    Copy-Item -LiteralPath (Join-Path $repoRoot "update.bat") -Destination (Join-Path $stage "update.bat")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\updater.ps1") -Destination (Join-Path $stage "updater\updater.ps1")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\apply-update.ps1") -Destination (Join-Path $stage "updater\apply-update.ps1")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\updater.version") -Destination (Join-Path $stage "updater\updater.version")
    Copy-Item -LiteralPath (Join-Path $repoRoot "updater\README.md") -Destination (Join-Path $stage "updater\README.md")
    Copy-Item -LiteralPath $MinisignBinary -Destination (Join-Path $stage "updater\minisign.exe")
    Copy-Item -LiteralPath $PublicKeyPath -Destination (Join-Path $stage "updater\public-key.txt")

    $versionValue = Get-Content -LiteralPath (Join-Path $repoRoot "version.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $versionValue.version = $Version
    $versionValue.components.app = $Version
    $versionValue.components.core_cpu = $Version
    $versionValue.components.core_cuda = $Version
    $versionValue | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "version.json") -Encoding UTF8

    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $OutputPath -CompressionLevel Optimal
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

$hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Bootstrap patch: $OutputPath"
Write-Host "SHA-256: $hash"
