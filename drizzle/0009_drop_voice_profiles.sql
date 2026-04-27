-- Drop the voice_profiles table.
--
-- The voice-extractor pipeline (skill + agent + worker + queue +
-- /api/voice-profile endpoints + VoiceSection settings UI + reply-hardening
-- voiceBlock injection) was end-to-end orphaned: the only UI trigger for
-- extraction (`VoiceSection`) was never mounted, and the plan-execute
-- `setup_task` route bottoms out in a "legacy stub: state transition only"
-- path that never actually invokes the worker. The read side
-- (`loadVoiceBlockForUser` from monitor.ts → reply-hardening) ran daily
-- but always found an empty table because no writer existed in production.
DROP INDEX IF EXISTS "voice_profiles_user_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "voice_profiles";
