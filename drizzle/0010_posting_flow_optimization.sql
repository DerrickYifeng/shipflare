-- Posting flow optimization: lifecycle phase, post history, code diff support

-- Requirement 1: Product lifecycle phase (pre_launch | launched | scaling)
ALTER TABLE products ADD COLUMN IF NOT EXISTS lifecycle_phase text NOT NULL DEFAULT 'pre_launch';

-- Requirement 2: Channel post history (recent posts/replies fetched on connect)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS post_history jsonb;

-- Requirement 4: Code scan diff support for daily incremental scanning
ALTER TABLE code_snapshots ADD COLUMN IF NOT EXISTS diff_summary text;
ALTER TABLE code_snapshots ADD COLUMN IF NOT EXISTS changes_detected boolean DEFAULT false;
ALTER TABLE code_snapshots ADD COLUMN IF NOT EXISTS last_diff_at timestamp;
