ALTER TABLE "channels" ALTER COLUMN "oauth_token_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "refresh_token_encrypted" DROP NOT NULL;