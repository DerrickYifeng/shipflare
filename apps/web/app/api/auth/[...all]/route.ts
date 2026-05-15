import { getAuth } from "@/auth";

// Better Auth owns every route under /api/auth/* — sign-in, OAuth callback,
// session, sign-out, etc. The catch-all `[...all]` segment delegates the
// raw Request/Response to the singleton handler. We expose both GET and POST
// because Better Auth uses both (GET for OAuth redirects / callbacks, POST
// for sign-out and credential flows even though we only ship GitHub OAuth).

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  return auth.handler(req);
}

export async function POST(req: Request): Promise<Response> {
  const auth = getAuth();
  return auth.handler(req);
}
