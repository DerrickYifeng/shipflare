import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/lib/db';
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from '@/lib/db/schema';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
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
      // Store GitHub profile data on first sign-in
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
