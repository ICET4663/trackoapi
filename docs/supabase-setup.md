# Supabase Setup

Use Supabase free Postgres as the first production database for Tracko.

## 1. Create Project

1. Go to Supabase.
2. Create a new project.
3. Save the database password securely.
4. Open Project Settings > Database.
5. Copy the connection string.

Use the pooled or direct Postgres URL in `.env`:

```text
DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres?schema=public"
```

## 2. Configure Backend

```powershell
cd "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api"
copy .env.example .env
```

Set:

```text
DATABASE_URL="your Supabase database URL"
JWT_ACCESS_SECRET="long random string"
JWT_REFRESH_SECRET="another long random string"
MOCK_OTP_CODE="123456"
CORS_ORIGIN="http://localhost:8082,https://your-frontend-domain"
```

## 3. Run Prisma

```powershell
npm install
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
```

## 4. Run API

```powershell
npm run start:dev
```

View:

```text
http://localhost:4000/v1/health
http://localhost:4000/v1/legal/privacy
http://localhost:4000/v1/legal/terms
http://localhost:4000/v1/legal/account-deletion
```

## 5. Connect Mobile App

In the Expo app env:

```text
EXPO_PUBLIC_API_BASE_URL=http://localhost:4000
```

For deployed web/mobile, use the deployed backend URL.
