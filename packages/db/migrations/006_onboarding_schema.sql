-- Migration 006: onboarding flow schema
-- - Extend products with category/targetAudience/launchChannel/usersBucket/onboardingCompletedAt
-- - Rebuild products to drop the old CHECK constraint on state and switch the enum to mvp/launching/launched
-- - Add onboarding_drafts table

-- 1) Rebuild products with the new enum, new columns, no CHECK constraint
--    (Drizzle's enum is application-level only; we drop the SQL-level CHECK
--    so writes from the new code path succeed.)

CREATE TABLE products_new (
  "userId" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT,
  "description" TEXT,
  "keywords" TEXT,
  "valueProp" TEXT,
  "url" TEXT,
  "category" TEXT,
  "targetAudience" TEXT,
  "state" TEXT NOT NULL DEFAULT 'mvp',
  "launchDate" INTEGER,
  "launchedAt" INTEGER,
  "launchChannel" TEXT,
  "usersBucket" TEXT,
  "onboardingCompletedAt" INTEGER,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

INSERT INTO products_new
  SELECT
    userId, name, description, keywords, valueProp, url,
    NULL AS category,
    NULL AS targetAudience,
    CASE state
      WHEN 'draft'      THEN 'mvp'
      WHEN 'pre-launch' THEN 'launching'
      WHEN 'growing'    THEN 'launched'
      ELSE state
    END,
    launchDate, launchedAt,
    NULL AS launchChannel,
    NULL AS usersBucket,
    NULL AS onboardingCompletedAt,
    createdAt, updatedAt
  FROM products;

DROP TABLE products;
ALTER TABLE products_new RENAME TO products;

-- 2) Onboarding drafts table
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  userId TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);
