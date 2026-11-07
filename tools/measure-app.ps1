param(
    [string]$Name = "terminion.exe",
    [int]$RootPid = 0,
    [int]$Seconds = 5
)

$all = Get-CimInstance Win32_Process
if ($RootPid -eq 0) {
    $candidates = @($all | Where-Object { $_.Name -eq $Name })
    if ($candidates.Count -eq 0) {
        Write-Output "$Name is not running."
        exit 1
    }
    $otherNames = @{}
    foreach ($p in $all) { $otherNames[[int]$p.ProcessId] = $p.Name }
    $root = $candidates | Where-Object {
        $parent = [int]$_.ParentProcessId
        -not $otherNames.ContainsKey($parent) -or $otherNames[$parent] -ne $Name
    } | Select-Object -First 1
    if (-not $root) { $root = $candidates | Select-Object -First 1 }
    $RootPid = [int]$root.ProcessId
}

$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($RootPid)
$added = $true
while ($added) {
    $added = $false
    foreach ($p in $all) {
        if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
            [void]$ids.Add([int]$p.ProcessId)
            $added = $true
        }
    }
}

$before = @{}
$start = Get-Date
foreach ($id in $ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) { $before[$id] = $proc.TotalProcessorTime.TotalSeconds }
}
Start-Sleep -Seconds $Seconds
$after = @{}
foreach ($id in $ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) { $after[$id] = $proc.TotalProcessorTime.TotalSeconds }
}
$elapsed = ((Get-Date) - $start).TotalSeconds
$cpuDelta = 0.0
foreach ($id in $before.Keys) {
    if ($after.ContainsKey($id)) {
        $cpuDelta += [math]::Max(0, $after[$id] - $before[$id])
    }
}
$cores = [Environment]::ProcessorCount
$cpuPercent = if ($elapsed -gt 0) { $cpuDelta / $elapsed / $cores * 100 } else { 0 }

$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $ids.Contains([int]$_.IDProcess) }
$privateMb = [math]::Round((($perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB), 1)
$workingMb = [math]::Round((($perf | Measure-Object WorkingSet -Sum).Sum / 1MB), 1)
$processCount = @($perf).Count

"Name:          $Name"
"Root PID:      $RootPid"
"Processes:     $processCount"
"CPU:           $([math]::Round($cpuPercent, 2))% (all cores)"
"Private WS:    $privateMb MB"
"Working set:   $workingMb MB"
