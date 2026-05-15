CREATE TABLE IF NOT EXISTS growth_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x', 'reddit')),
  capturedAt INTEGER NOT NULL,
  metrics TEXT NOT NULL,    -- JSON object: { impressions, replies, followers, posts, ... }
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_growth_user_platform_captured
  ON growth_snapshots(userId, platform, capturedAt DESC);
