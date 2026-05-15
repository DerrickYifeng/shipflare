/**
 * Sanctioned reader of `channels.oauth_token_encrypted` (per CLAUDE.md
 * "Security TODO" §1, bullet "Only the three helpers …").
 *
 * INVARIANT: this file is the ONLY place in `apps/core` that may
 *   - select `oauthTokenEncrypted` / `oauthRefreshEncrypted` columns from D1, AND
 *   - call `@shipflare/crypto`'s `decrypt()` on those values.
 *
 * Every other read path in `apps/core/src/agents/**` and
 * `apps/core/src/workers/**` (Phase 2) MUST use an explicit projection that
 * omits the encrypted columns. Adding a new caller that decrypts tokens here
 * is allowed; reaching past this module to decrypt directly is a review reject.
 *
 * The legacy monolith expressed the same invariant via `src/lib/platform-deps.ts`
 * (`createPlatformDeps` / `createClientFromChannel` / `createPublicPlatformDeps`).
 * Phase 1's worker world is simpler — there's no public anonymous-read path
 * (every platform call originates inside an authenticated agent DO), so a
 * single `getChannel(env, userId, platform)` helper covers the surface.
 *
 * Status filter: only `status = 'active'` rows are returned. Revoked / error
 * channels surface as `null`, mirroring the monolith's `createPlatformDeps`
 * semantics (silent skip → callers see "platform not connected" rather than
 * "tried to decrypt a revoked token").
 */

import { decrypt } from "@shipflare/crypto";
import { createDb, channels, and, eq } from "@shipflare/db";
import type { PlatformSlug } from "@shipflare/shared";
import type { Env } from "../index";

/**
 * A live OAuth-backed platform connection.
 *
 * `accessToken` / `refreshToken` are DECRYPTED plaintext — callers must NOT
 * persist them anywhere. Pass them straight to the platform SDK and let GC
 * clear the closure.
 */
export interface ChannelConnection {
  accessToken: string;
  refreshToken: string | null;
  externalUserId: string;
  username: string | null;
  scope: string | null;
}

/**
 * Look up the active channel row for `(userId, platform)` and return a
 * decrypted `ChannelConnection`. Returns `null` when:
 *   - the user has no row for that platform
 *   - the row exists but status is not `'active'` (revoked / error)
 *   - the row is corrupted (decrypt failure — logged, treated as not-connected)
 *
 * Failure handling: decrypt errors return `null` rather than throwing. The
 * upstream tool surfaces "channel not connected" to the founder; a corrupted
 * row is operationally indistinguishable from a missing row and we don't want
 * agent DOs to crash on a single bad envelope.
 */
export async function getChannel(
  env: Env,
  userId: string,
  platform: PlatformSlug,
): Promise<ChannelConnection | null> {
  const db = createDb(env.DB);
  const rows = await db
    .select({
      externalUserId: channels.externalUserId,
      username: channels.username,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      oauthRefreshEncrypted: channels.oauthRefreshEncrypted,
      scope: channels.scope,
      status: channels.status,
    })
    .from(channels)
    .where(
      and(
        eq(channels.userId, userId),
        eq(channels.platform, platform),
        eq(channels.status, "active"),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  try {
    const accessToken = await decrypt(
      row.oauthTokenEncrypted,
      env.CHANNEL_ENC_KEY,
    );
    const refreshToken = row.oauthRefreshEncrypted
      ? await decrypt(row.oauthRefreshEncrypted, env.CHANNEL_ENC_KEY)
      : null;
    return {
      accessToken,
      refreshToken,
      externalUserId: row.externalUserId,
      username: row.username,
      scope: row.scope,
    };
  } catch (err) {
    console.error(
      `[channel] failed to decrypt token for userId=${userId} platform=${platform}:`,
      err,
    );
    return null;
  }
}
