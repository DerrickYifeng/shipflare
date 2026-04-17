CREATE INDEX IF NOT EXISTS "todo_items_user_status_expires" ON "todo_items" ("user_id","status","expires_at");
