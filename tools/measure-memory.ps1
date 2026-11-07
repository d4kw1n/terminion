param([int]$RootPid = 0)

$procs = Get-CimInstance Win32_Process
if ($RootPid -eq 0) {
    $root = $procs | Where-Object { $_.Name -eq 'terminion.exe' } | Select-Object -First 1
    if (-not $root) {
        Write-Output 'Terminion is not running.'
        exit 1
    }
    $RootPid = [int]$root.ProcessId
}

$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($RootPid)
$added = $true
while ($added) {
    $added = $false
    foreach ($p in $procs) {
        if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
            [void]$ids.Add([int]$p.ProcessId)
            $added = $true
        }
    }
}

$rows = $procs |
    Where-Object { $ids.Contains([int]$_.ProcessId) } |
    ForEach-Object {
        $gp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        [pscustomobject]@{
            Name         = $_.Name
            Pid          = $_.ProcessId
            WorkingSetMB = [math]::Round(($gp.WorkingSet64 / 1MB), 1)
            PrivateMB    = [math]::Round(($gp.PrivateMemorySize64 / 1MB), 1)
        }
    }

$rows | Format-Table -AutoSize
'WORKING SET MB: ' + [math]::Round((($rows | Measure-Object WorkingSetMB -Sum).Sum), 1)
'PRIVATE MB:     ' + [math]::Round((($rows | Measure-Object PrivateMB -Sum).Sum), 1)

$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $ids.Contains([int]$_.IDProcess) } |
    ForEach-Object {
        [pscustomobject]@{
            Name             = $_.Name
            Pid              = $_.IDProcess
            PrivateWorkingMB = [math]::Round(($_.WorkingSetPrivate / 1MB), 1)
        }
    }
$perf | Format-Table -AutoSize
'PRIVATE WORKING SET MB: ' + [math]::Round((($perf | Measure-Object PrivateWorkingMB -Sum).Sum), 1)
