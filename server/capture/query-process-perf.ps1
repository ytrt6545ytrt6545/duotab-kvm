param([int]$ProcessId)

try {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    $cpuSec = $proc.CPU
    
    $gpuTotal = 0.0
    try {
        $counters = (Get-Counter ("\GPU Engine(*pid_$ProcessId*)\Utilization Percentage") -ErrorAction SilentlyContinue).CounterSamples
        if ($counters) {
            foreach ($c in $counters) {
                $gpuTotal += $c.CookedValue
            }
        }
    } catch {}

    $wsMB = [Math]::Round($proc.WorkingSet64 / 1MB, 1)
    $gpuRounded = [Math]::Round($gpuTotal, 1)
    "$cpuSec,$gpuRounded,$wsMB"
} catch {
    "0,0,0"
}
