[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$Commit = "",
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path $PSScriptRoot -Parent
if ($Root -eq "") { $Root = $repositoryRoot }
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
            throw "Frozen public example changed or missing: $name. Keep local recordings and transcripts in webui/voice/."
        }
    }
}

try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if ($Commit -ne "") {
        $actual = @{}
        foreach ($line in (Invoke-Git @("ls-tree", "-r", "--format=%(objectname) %(path)", $Commit, "--", "$directory/"))) {
            $blob, $path = $line -split ' ', 2
            $actual[$path.Substring($directory.Length + 1)] = $blob
        }
        Assert-Examples $actual
        $privateFiles = @(Invoke-Git @("ls-tree", "-r", "--name-only", $Commit, "--", "webui/voice/"))
    } else {
        $examples = [IO.Path]::GetFullPath((Join-Path $Root $directory))
        $actual = @{}
        foreach ($file in Get-ChildItem -LiteralPath $examples -File -Recurse -Force) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Public examples cannot be links." }
            $name = $file.FullName.Substring($examples.Length + 1).Replace('\', '/')
            $blob = @(Invoke-Git @("hash-object", "--path=$directory/$name", "--", $file.FullName))
            $actual[$name] = $blob[0]
        }
        Assert-Examples $actual
        $privateFiles = @(Invoke-Git @("ls-files", "--", "webui/voice/"))
    }
    if ($privateFiles.Count -ne 0) { throw "Runtime webui/voice files must stay untracked." }
    if (-not $Quiet) { Write-Host "Frozen demo voices verified: original 9 WAVs and prompt_text." }
} finally {
    [Console]::OutputEncoding = $previousEncoding
}
