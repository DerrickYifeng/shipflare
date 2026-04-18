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
      if (account?.provider === 'github' && profile) {
        const githubProfile = profile as { id?: number; login?: string };
        if (githubProfile.id && user.id) {
          const { eq } = await import('drizzle-orm');
          await db
            .update(users)
            .set({ githubId: String(githubProfile.id) })
            .where(eq(users.id, user.id));
        }
      }
      return true;
    },
  },
  pages: {
    signIn: '/',
  },
});
