CREATE TABLE "voice_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"register" text DEFAULT 'builder_log' NOT NULL,
	"pronouns" text DEFAULT 'i' NOT NULL,
	"capitalization" text DEFAULT 'sentence' NOT NULL,
	"emoji_policy" text DEFAULT 'sparing' NOT NULL,
	"signature_emoji" text,
	"punctuation_signatures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"humor_register" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worldview_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opener_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closer_policy" text DEFAULT 'silent_stop' NOT NULL,
	"voice_strength" text DEFAULT 'moderate' NOT NULL,
	"extracted_style_card_md" text,
	"sample_tweets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avg_sentence_length" real,
	"opener_histogram" jsonb DEFAULT '{}'::jsonb,
	"length_histogram" jsonb DEFAULT '{}'::jsonb,
	"extraction_version" integer DEFAULT 0 NOT NULL,
	"last_extracted_at" timestamp,
	"style_card_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_user_channel" UNIQUE("user_id","channel")
);
--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_profiles_user_idx" ON "voice_profiles" USING btree ("user_id");