import { auth, signIn } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export default async function SignInPage() {
  const session = await auth();

  if (session?.user?.id) {
    // Check if user has completed onboarding
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.userId, session.user.id))
      .limit(1);

    if (product) {
      redirect('/dashboard');
    } else {
      redirect('/onboarding');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-sf-bg-secondary">
      <div className="w-full max-w-sm bg-sf-bg-primary border border-sf-border rounded-[var(--radius-sf-lg)] p-8">
        <div className="text-center mb-8">
          <h1 className="text-[24px] font-semibold text-sf-text-primary tracking-tight">
            ShipFlare
          </h1>
          <p className="mt-2 text-[15px] text-sf-text-secondary">
            AI marketing autopilot for indie developers
          </p>
        </div>

        <form
          action={async () => {
            'use server';
            await signIn('github', { redirectTo: '/onboarding' });
          }}
        >
          <button
            type="submit"
            className="
              flex items-center justify-center gap-3
              w-full min-h-[44px] px-4 py-3
              bg-sf-text-primary text-white
              rounded-[var(--radius-sf-md)]
              font-medium text-[15px]
              hover:bg-sf-text-secondary
              transition-colors duration-150
              cursor-pointer
            "
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z" clipRule="evenodd" />
            </svg>
            Sign in with GitHub
          </button>
        </form>

        <p className="mt-6 text-center text-[11px] text-sf-text-tertiary">
          By signing in, you agree to our terms of service.
        </p>
      </div>
    </main>
  );
}
