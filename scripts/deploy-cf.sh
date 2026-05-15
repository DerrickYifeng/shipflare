#!/usr/bin/env bash
set -euo pipefail

# Deploy ShipFlare to Cloudflare in the correct order.
#
# Prerequisites (one-time, run via scripts/cf-deploy-checklist.md):
#   - Cloudflare account with Workers Paid plan (Durable Objects + D1 + Workflows)
#   - `wrangler login` completed
#   - D1 database created (`wrangler d1 create shipflare-prod`)
#   - database_id pasted into both apps/core/wrangler.jsonc and apps/web/wrangler.jsonc
#   - Migrations applied (`wrangler d1 migrations apply shipflare-prod --remote`)
#   - All secrets set via `wrangler secret put <NAME>` on BOTH workers
#   - X + Reddit OAuth apps registered with prod callback URLs
#
# Usage:
#   ./scripts/deploy-cf.sh [--dry-run]
#
# Order: D1 migrations → apps/core (DO + D1 host) → apps/web (Service Binding
# to core). apps/web's Service Binding can only resolve after apps/core is live.

cd "$(dirname "$0")/.."

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "DRY RUN — no changes will be deployed"
fi

echo ""
echo "→ Step 1/4: Install workspace deps + typecheck packages"
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/*" typecheck

echo ""
echo "→ Step 2/4: Apply D1 migrations (remote)"
if [[ -z "$DRY_RUN" ]]; then
  (
    cd apps/core
    pnpm exec wrangler d1 migrations apply shipflare-prod --remote || {
      echo "WARN: D1 migrations apply failed. If this is a fresh deploy, run:"
      echo "  cd apps/core && pnpm exec wrangler d1 create shipflare-prod"
      echo "  then paste database_id into apps/core/wrangler.jsonc AND apps/web/wrangler.jsonc"
      exit 1
    }
  )
else
  echo "  (skipped — dry run)"
fi

echo ""
echo "→ Step 3/4: Deploy apps/core (DO host + D1 binding)"
(
  cd apps/core
  # shellcheck disable=SC2086
  pnpm exec wrangler deploy $DRY_RUN
)

echo ""
echo "→ Step 4/4: Build + deploy apps/web (Next.js via OpenNext)"
(
  cd apps/web
  pnpm run build                # next build
  pnpm run build:worker         # opennextjs-cloudflare build
  # shellcheck disable=SC2086
  pnpm exec wrangler deploy $DRY_RUN
)

echo ""
echo "Deploy complete. Verify:"
echo "  - core /healthz responds"
echo "  - web landing page renders"
echo "  - Sign in with GitHub works"
echo "  - Better Auth user.create.after hook fires"
echo "    POST /agents/cmo/<userId>/internal/init on the core worker"
