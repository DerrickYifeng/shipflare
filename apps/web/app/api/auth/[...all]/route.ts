import { getAuth } from "@/auth";

// Better Auth owns every route under /api/auth/* — sign-in, OAuth callback,
// session, sign-out, etc. The catch-all `[...all]` segment delegates the
// raw Request/Response to the singleton handler.
//
// One intercept: when `databaseHooks.user.create.before` in `auth.ts` throws
// (the email isn't on the allowlist), Better Auth converts the throw into a
// 302 to `/api/auth/error?error=unable_to_create_user` — the generic error
// page. We want users on `/waitlist` instead, where they can request access.
// The intercept below recognizes that redirect shape and rewrites the
// location.

export const dynamic = "force-dynamic";

const WAITLIST_REDIRECT_CODES = new Set(["unable_to_create_user"]);

async function withWaitlistRedirect(req: Request): Promise<Response> {
  const res = await getAuth().handler(req);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) {
      const url = new URL(location, req.url);
      const code = url.searchParams.get("error");
      if (
        url.pathname.endsWith("/api/auth/error") &&
        code &&
        WAITLIST_REDIRECT_CODES.has(code)
      ) {
        const target = new URL("/waitlist", req.url);
        target.searchParams.set("from", "denied");
        return Response.redirect(target.toString(), 302);
      }
    }
  }
  return res;
}

export async function GET(req: Request): Promise<Response> {
  return withWaitlistRedirect(req);
}

export async function POST(req: Request): Promise<Response> {
  return withWaitlistRedirect(req);
}
