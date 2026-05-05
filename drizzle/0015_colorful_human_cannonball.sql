CREATE TABLE "allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"invited_by" text NOT NULL,
	"note" text,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
CREATE INDEX "allowed_emails_revoked_idx" ON "allowed_emails" USING btree ("revoked_at");