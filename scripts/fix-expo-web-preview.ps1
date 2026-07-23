param(
  [string]$AppPath = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main",
  [string]$WebApiBaseUrl = "http://localhost:4000"
)

$ErrorActionPreference = "Stop"

$appJsonPath = Join-Path $AppPath "app.json"
$envLocalPath = Join-Path $AppPath ".env.local"

if (!(Test-Path $appJsonPath)) {
  throw "Cannot find app.json at $appJsonPath"
}

if (!(Test-Path $envLocalPath)) {
  throw "Cannot find .env.local at $envLocalPath"
}

$appJson = Get-Content $appJsonPath -Raw
$appJson = $appJson -replace '"reactCompiler"\s*:\s*true', '"reactCompiler": false'
Set-Content $appJsonPath $appJson

$envLocal = Get-Content $envLocalPath -Raw
if ($envLocal -match '(?m)^EXPO_PUBLIC_API_BASE_URL=') {
  $envLocal = $envLocal -replace '(?m)^EXPO_PUBLIC_API_BASE_URL=.*$', "EXPO_PUBLIC_API_BASE_URL=$WebApiBaseUrl"
} else {
  $envLocal = "$envLocal`r`nEXPO_PUBLIC_API_BASE_URL=$WebApiBaseUrl`r`n"
}
Set-Content $envLocalPath $envLocal

Write-Host "Expo web preview config updated."
Write-Host "React Compiler disabled for preview."
Write-Host "EXPO_PUBLIC_API_BASE_URL=$WebApiBaseUrl"
Write-Host ""
Write-Host "Now close Expo with Ctrl+C, then run:"
Write-Host "npx expo start --web --host localhost --port 8081 --clear"
