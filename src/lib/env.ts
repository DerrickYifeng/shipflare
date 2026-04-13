import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_SECRET: z.string().min(16),
  GITHUB_ID: z.string().min(1),
  GITHUB_SECRET: z.string().min(1),
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
  REDDIT_REDIRECT_URI: z.string().url(),
  // X OAuth (Free tier, for posting)
  X_CLIENT_ID: z.string().min(1).optional(),
  X_CLIENT_SECRET: z.string().min(1).optional(),
  X_REDIRECT_URI: z.string().url().optional(),
  // xAI Grok (for X/Twitter search)
  XAI_API_KEY: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().min(32),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }

  return parsed.data;
}

export const env = validateEnv();
