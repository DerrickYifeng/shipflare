import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from '@/lib/db/schema';
import { encryptAccount, decryptAccount } from './account-encryption';
import { signInCallback } from './signin-callback';

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
    // allowDangerousEmailAccountLinking: safe here — both providers return
    // verified emails. The "dangerous" name in Auth.js docs targets providers
    // that surface unverified emails (account-takeover vector). Setting this
    // on BOTH so a Google user signing in via GitHub on the same email (or
    // vice versa) joins the existing user row instead of being rejected with
    // OAuthAccountNotLinked. See docs/superpowers/specs/2026-05-11-google-auth-design.md.
    GitHub({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
      allowDangerousEmailAccountLinking: true,
    }),
    Google({
      clientId: process.env.GOOGLE_ID!,
      clientSecret: process.env.GOOGLE_SECRET!,
      allowDangerousEmailAccountLinking: true,
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
    signIn: signInCallback,
  },
  events: {
    async signIn({ user, account, profile }) {
      if (!user.id) return; // shouldn't happen here, but guard
      try {
        if (account?.provider === 'github' && profile) {
          const githubProfile = profile as { id?: number | string; login?: string };
          await db
            .update(users)
            .set({
              ...(githubProfile.id !== undefined
                ? { githubId: String(githubProfile.id) }
                : {}),
              lastLoginAt: new Date(),
            })
            .where(eq(users.id, user.id));
        } else {
          await db
            .update(users)
            .set({ lastLoginAt: new Date() })
            .where(eq(users.id, user.id));
        }
      } catch (err) {
        // Stamp is observational metadata — never fail the sign-in.
        // (events run after session creation anyway, but log so a DB blip is visible.)
        const log = (await import('@/lib/logger')).createLogger('auth:events');
        log.error('failed to stamp signin metadata', err);
      }
    },
  },
  pages: {
    signIn: '/',
  },
});
