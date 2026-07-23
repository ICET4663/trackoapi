$ErrorActionPreference = "Stop"

$appRoot = "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"

if (!(Test-Path (Join-Path $appRoot "package.json"))) {
  throw "Could not find the Expo app at $appRoot"
}

$authServicePath = Join-Path $appRoot "src\services\auth-service.ts"
$authService = Get-Content $authServicePath -Raw
$authService = $authService.Replace(
  "async requestRegistrationCode(input: { email: string; phone: string }): Promise<{ sent: boolean; expiresAt: string }> {",
  "async requestRegistrationCode(input: { email: string; phone: string; role: UserRole }): Promise<{ sent: boolean; expiresAt: string; delivery?: unknown; devCode?: string }> {"
)
Set-Content -Path $authServicePath -Value $authService

$registrationContextPath = Join-Path $appRoot "src\store\registration-context.tsx"
$registrationContext = Get-Content $registrationContextPath -Raw
$registrationContext = $registrationContext.Replace(
  "await authService.requestRegistrationCode({ email: draft.email, phone: draft.phone });",
  "await authService.requestRegistrationCode({ email: draft.email, phone: draft.phone, role: draft.role });"
)
$registrationContext = $registrationContext.Replace(
  "}, [draft.email, draft.phone]);",
  "}, [draft.email, draft.phone, draft.role]);"
)
Set-Content -Path $registrationContextPath -Value $registrationContext

Write-Host "Done. Mobile registration OTP requests now include the selected role."
Write-Host "Restart Expo with: npx expo start --lan --clear"
