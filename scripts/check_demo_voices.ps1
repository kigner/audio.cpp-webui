[CmdletBinding()]
param(
    [string]$Commit = "HEAD",
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot "demo_voices_baseline.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$directory = [string]$baseline.directory
$previousEncoding = [Console]::OutputEncoding

function Invoke-Git {
    param([string[]]$Arguments)
    $result = @(& git -c core.quotepath=false -C $repositoryRoot @Arguments)
    if ($LASTEXITCODE -ne 0) { throw "Git failed while checking frozen demo voices." }
    return $result
}

function Assert-Examples {
    param([hashtable]$Actual)
    if ($Actual.Count -ne $baseline.files.Count) {
        throw "Frozen demo voices must contain exactly the original 9 WAVs and prompt_text."
    }
    foreach ($entry in $baseline.files) {
        $name = [string]$entry.name
        if ($Actual.Keys -cnotcontains $name -or $Actual[$name] -cne [string]$entry.blob) {
            throw "Frozen public example changed or missing: $name. Keep local recording and transcript edits out of commits."
        }
    }
}

try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    # Inspect committed Git objects only: local voice recordings and prompt edits
    # are intentionally allowed and must never become release inputs.
    $actual = @{}
    foreach ($line in (Invoke-Git @("ls-tree", "-r", "--format=%(objectname) %(path)", $Commit, "--", "$directory/"))) {
        $blob, $path = $line -split ' ', 2
        $actual[$path.Substring($directory.Length + 1)] = $blob
    }
    Assert-Examples $actual
    if (-not $Quiet) { Write-Host "Frozen demo voices verified: original 9 WAVs and prompt_text." }
} finally {
    [Console]::OutputEncoding = $previousEncoding
}
