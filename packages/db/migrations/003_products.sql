CREATE TABLE IF NOT EXISTS "products" (
  "userId" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT,
  "description" TEXT,
  "keywords" TEXT,
  "valueProp" TEXT,
  "url" TEXT,
  "state" TEXT NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft', 'pre-launch', 'launched', 'growing')),
  "launchDate" INTEGER,
  "launchedAt" INTEGER,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
