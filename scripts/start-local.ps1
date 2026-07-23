$ErrorActionPreference = "Stop"

$nodeVersion = node -v
Write-Host "Node version: $nodeVersion"

if ($nodeVersion -notmatch "^v(20|22)\.") {
  Write-Host "Tracko API expects Node 20 or 22 LTS. Install/use Node 22 before continuing." -ForegroundColor Yellow
  exit 1
}

if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Update DATABASE_URL before running migrations." -ForegroundColor Yellow
}

if (!(Test-Path "node_modules")) {
  npm install
}

npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run start:dev
