-- Adds the RateLimitBucket table backing RateLimitService, replacing an in-memory Map
-- that doesn't work correctly on Vercel serverless (each invocation can land on a
-- different, memory-isolated instance).
-- Generated from `prisma migrate diff` against prisma/schema.prisma (not hand-written).
--
-- Apply via the Supabase SQL editor or
-- `psql "$DATABASE_URL" -f prisma/manual-sql/20260827b_add_rate_limit_bucket.sql`.
-- Then regenerate the Prisma client (PRISMA_CLIENT_ENGINE_TYPE=binary and
-- PRISMA_CLI_QUERY_ENGINE_TYPE=binary if running on 32-bit Node, per this repo's
-- existing package.json scripts).

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
