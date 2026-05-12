'use server';

import { signIn, signOut } from '@/lib/auth';

export async function signInWithGitHub() {
  // Land on /briefing after auth — that page gates on `products` presence
  // and forwards new users to /onboarding, so this single target works
  // for both first-time and returning users.
  await signIn('github', { redirectTo: '/briefing' });
}

export async function signInWithGoogle() {
  // Mirrors signInWithGitHub: lands on /briefing, which gates on `products`
  // presence and forwards new users to /onboarding.
  await signIn('google', { redirectTo: '/briefing' });
}

export async function signOutAction() {
  await signOut({ redirectTo: '/' });
}
