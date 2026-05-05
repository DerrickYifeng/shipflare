import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/lib/db';
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from '@/lib/db/schema';
import { encryptAccount, decryptAccount } from './account-encryption';
import { isEmailAllowed, normalizeEmail } from './allowlist';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:signin');

const baseAdapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts,
  sessionsTable: sessions,
  verificationTokensTable: verificationTokens,
});

const adapter: Adapter = {
  ...baseAdapter,
  linkAccount: async (data) => {
    const encrypted = encryptAccount(data);
    await baseAdapter.linkAccount?.(encrypted);
  },
  getAccount: async (providerAccountId, provider) => {
    const row = await baseAdapter.getAccount?.(providerAccountId, provider);
    return decryptAccount(row ?? null);
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
    }),
  ],
  session: {
    strategy: 'database',
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
    async signIn({ user, account, profile }) {
      // Gate 1: allowlist. Reject before mutating anything.
      // GitHub OAuth always returns an email when scope `user:email` is
      // requested (the default for the next-auth GitHub provider). If
      // the user has hidden their primary email in GitHub privacy
      // settings, `user.email` may be null — reject with a clear log.
      const rawEmail = user.email ?? null;
      const email = rawEmail ? normalizeEmail(rawEmail) : null;
      if (!email) {
        log.warn('signIn rejected: no email returned from provider');
        return false;
      }
      if (!(await isEmailAllowed(email))) {
        log.warn(`signIn rejected: ${email} not in allowlist`);
        return false;
      }

      // Gate passed — stamp metadata. Bundle githubId + lastLoginAt in
      // one UPDATE so we don't double-roundtrip the DB.
      if (account?.provider === 'github' && profile && user.id) {
        const githubProfile = profile as { id?: number; login?: string };
        const { eq } = await import('drizzle-orm');
        await db
          .update(users)
          .set({
            ...(githubProfile.id ? { githubId: String(githubProfile.id) } : {}),
            lastLoginAt: new Date(),
          })
          .where(eq(users.id, user.id));
      } else if (user.id) {
        const { eq } = await import('drizzle-orm');
        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));
      }

      return true;
    },
  },
  pages: {
    signIn: '/',
  },
});
