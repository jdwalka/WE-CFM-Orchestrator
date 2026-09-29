# Set Google Gemini API Keys and Models for User Environment
# Reads keys from G:\WECRYP\.env — no hardcoded secrets in this script.
$envFile = "G:\WECRYP\.env"
$keys = @{}
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') { $keys[$Matches[1]] = $Matches[2] }
  }
}
foreach ($name in @("GEMINI_API_KEY","GEMINI_API_KEY_1","GEMINI_API_KEY_2","GEMINI_API_KEY_3","GOOGLE_API_KEY","GOOGLE_API_KEY_1","GOOGLE_API_KEY_2","GOOGLE_API_KEY_3")) {
  if ($keys[$name]) { [Environment]::SetEnvironmentVariable($name, $keys[$name], "User") }
}
[Environment]::SetEnvironmentVariable("GEMINI_MODEL", "gemini-flash-latest", "User")
[Environment]::SetEnvironmentVariable("GOOGLE_MODEL", "gemini-flash-latest", "User")
[Environment]::SetEnvironmentVariable("GEMINI_MODEL_FALLBACK", "gemini-3.6-flash", "User")
[Environment]::SetEnvironmentVariable("GEMINI_MODELS", "gemini-flash-latest,gemini-3.8-flash,gemini-3.6-flash", "User")
[Environment]::SetEnvironmentVariable("GOOGLE_CLOUD_PROJECT", "931699483883", "User")
Write-Host "[OK] Gemini API Keys (from .env) and Models registered to Windows User Environment." -ForegroundColor Green
