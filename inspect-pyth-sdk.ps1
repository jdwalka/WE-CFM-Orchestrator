$base = "G:\WECRYP\node_modules\@pythnetwork\pyth-lazer-sdk"
Write-Host "Looking in: $base"
if (Test-Path $base) {
  Write-Host "Exists. Listing files..."
  Get-ChildItem $base -Recurse -Depth 4 -Include "*.md","*.d.ts","index.*","README*" -ErrorAction SilentlyContinue | Select-Object -First 10 FullName
  $r = Join-Path $base "README.md"
  if (Test-Path $r) {
    Write-Host "=== README ==="
    Get-Content $r -TotalCount 150
  }
  $types = Get-ChildItem $base -Recurse -Filter "*.d.ts" -ErrorAction SilentlyContinue | Select -First 1
  if ($types) {
    Write-Host "=== TYPES: $($types.FullName) ==="
    Get-Content $types.FullName -TotalCount 100
  }
} else {
  Write-Host "No SDK at $base"
  Get-ChildItem "G:\WECRYP\node_modules" -Filter "*pyth*" -Directory -ErrorAction SilentlyContinue | Select FullName
}
