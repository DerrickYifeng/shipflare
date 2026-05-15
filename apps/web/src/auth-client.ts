import { createAuthClient } from "better-auth/react";

// Browser-side Better Auth client. `signIn.social` POSTs to /api/auth/sign-in/social
// (which is what the catch-all route handler at app/api/auth/[...all]/route.ts
// serves). The plain `<a href="/api/auth/sign-in/social?provider=github">` link
// approach 404s because that endpoint is POST-only.
//
// baseURL is omitted on purpose — Better Auth defaults to same-origin, which is
// what we want (the client always talks to its own Web Worker).
export const authClient = createAuthClient();
