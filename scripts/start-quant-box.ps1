# Start Quant Box (WECRYP)
# This script uses Start-Process with ProcessorAffinity to strictly bind the entire process tree to CCX0.
# Bitmask 255 (Binary 11111111) targets the first 8 logical cores, preventing cross-CCX L3 cache thrashing.

$AffinityMask = 255

Write-Host "Starting WE-CRYPTO Quant Box on CCX0 (Mask $AffinityMask)..." -ForegroundColor Cyan

# Start the Node/Electron app
$Process = Start-Process -FilePath "npm" -ArgumentList "start" -PassThru

# Apply the affinity mask immediately
$Process.ProcessorAffinity = $AffinityMask

Write-Host "App launched with PID $($Process.Id) locked to L3 Cache block." -ForegroundColor Green
