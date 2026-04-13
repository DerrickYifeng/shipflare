CREATE TABLE IF NOT EXISTS "code_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "product_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "repo_url" text NOT NULL,
  "tech_stack" jsonb NOT NULL,
  "file_tree" jsonb NOT NULL,
  "key_files" jsonb NOT NULL,
  "scan_summary" text,
  "commit_sha" text,
  "scanned_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "code_snapshots"
  ADD CONSTRAINT "code_snapshots_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "code_snapshots"
  ADD CONSTRAINT "code_snapshots_product_id_products_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."products"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "code_snapshots"
  ADD CONSTRAINT "code_snapshots_product_id_unique"
  UNIQUE("product_id");
