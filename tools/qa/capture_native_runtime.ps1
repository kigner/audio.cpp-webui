param([Parameter(Mandatory=$true)][string]$ExpectedExe)
$ErrorActionPreference = 'Stop'
$records = @()
foreach ($native in @(Get-CimInstance Win32_Process -Filter "name='audiocpp_server.exe'")) {
    if ($native.ExecutablePath -ne $ExpectedExe) { continue }
    $match = [regex]::Match($native.CommandLine, '--config\s+(?:"([^"]+)"|(\S+))')
    if (-not $match.Success) { continue }
    $configPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $records += [pscustomobject]@{
        pid=$native.ProcessId; parent_pid=$native.ParentProcessId; created=$native.CreationDate; executable=$native.ExecutablePath
        config_path=$configPath; port=$config.port; backend=$config.backend
        models=$config.models
        listener_owners=@(Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    }
}
ConvertTo-Json -InputObject $records -Depth 15 -Compress
