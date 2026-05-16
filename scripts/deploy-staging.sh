#!/usr/bin/env bash
set -euo pipefail

# Deploy ShipFlare to the Cloudflare STAGING environment.
#
# One-time staging setup (run once before the first deploy):
#   1. Provision the staging D1 database:
#        cd apps/core && pnpm exec wrangler d1 create shipflare-staging
#      Paste the returned database_id into both wrangler.jsonc files
#      (search for REPLACE_WITH_STAGING_DB_ID).
#
#   2. Apply schema:
#        cd apps/core && pnpm exec wrangler d1 migrations apply shipflare-staging --remote --env staging
#
#   3. Set secrets (both apps need --env staging):
#        # apps/core
#        cd apps/core
#        pnpm exec wrangler secret put ANTHROPIC_API_KEY --env staging
#        pnpm exec wrangler secret put XAI_API_KEY --env staging
#        pnpm exec wrangler secret put MCP_JWT_SECRET --env staging
#        pnpm exec wrangler secret put CHANNEL_ENC_KEY --env staging
#        # apps/web (use the SAME MCP_JWT_SECRET + CHANNEL_ENC_KEY as core)
#        cd ../web
#        pnpm exec wrangler secret put BETTER_AUTH_SECRET --env staging
#        pnpm exec wrangler secret put BETTER_AUTH_URL --env staging   # staging worker URL
#        pnpm exec wrangler secret put GITHUB_CLIENT_ID --env staging
#        pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env staging
#        pnpm exec wrangler secret put X_CLIENT_ID --env staging
#        pnpm exec wrangler secret put X_CLIENT_SECRET --env staging
#        pnpm exec wrangler secret put REDDIT_CLIENT_ID --env staging
#        pnpm exec wrangler secret put REDDIT_CLIENT_SECRET --env staging
#        pnpm exec wrangler secret put MCP_JWT_SECRET --env staging
#        pnpm exec wrangler secret put CHANNEL_ENC_KEY --env staging
#        pnpm exec wrangler secret put CORE_PUBLIC_URL --env staging   # staging core URL
#
#   4. Register OAuth apps with staging callback URLs:
#        GitHub:  https://shipflare-web-staging.<account>.workers.dev/api/auth/callback/github
#        X:       https://shipflare-web-staging.<account>.workers.dev/api/channels/x/callback
#        Reddit:  https://shipflare-web-staging.<account>.workers.dev/api/channels/reddit/callback
#
# Usage:
#   ./scripts/deploy-staging.sh [--dry-run]

cd "$(dirname "$0")/.."

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "DRY RUN — no changes will be deployed"
fi

ENV="staging"

echo ""
echo "→ Step 1/4: Install workspace deps + typecheck packages"
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/*" typecheck

echo ""
echo "→ Step 2/4: Apply D1 migrations (staging)"
if [[ -z "$DRY_RUN" ]]; then
  (
    cd apps/core
    pnpm exec wrangler d1 migrations apply shipflare-staging --remote --env "$ENV" || {
      echo "ERROR: D1 migrations failed."
      echo "If this is the first staging deploy, run the one-time setup at the top of this script."
      exit 1
    }
  )
else
  echo "  (skipped — dry run)"
fi

echo ""
echo "→ Step 3/4: Deploy apps/core (staging)"
(
  cd apps/core
  # shellcheck disable=SC2086
  pnpm exec wrangler deploy --env "$ENV" $DRY_RUN
)

echo ""
echo "→ Step 4/4: Build + deploy apps/web (staging)"
(
  cd apps/web
  pnpm run build
  pnpm run build:worker
  # shellcheck disable=SC2086
  pnpm exec wrangler deploy --env "$ENV" $DRY_RUN
)

echo ""
echo "Staging deploy complete."
echo "Workers:"
echo "  core:  https://shipflare-core-staging.<account>.workers.dev"
echo "  web:   https://shipflare-web-staging.<account>.workers.dev"
echo ""
echo "Smoke test:"
echo "  curl https://shipflare-core-staging.<account>.workers.dev/healthz"
echo "  open https://shipflare-web-staging.<account>.workers.dev"
