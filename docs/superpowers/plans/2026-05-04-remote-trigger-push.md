# RemoteTrigger / Push Notifications (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out remote-trigger-push plan" to expand into bite-sized TDD steps.
> Status: P1 (do soon). Roadmap row #11.

## Goal

Let an agent **proactively notify the founder** outside the /team conversation thread — push notification to phone (PWA / FCM), email summary, or both. Engine's RemoteTriggerTool covers this. Today, founder must open /team to see anything; the team is invisible until visited.

## Architecture

1. **Pick a transport**: web push (PWA) is the lightest — no native app, browser-managed subscriptions. Email is a fallback. Skip native push for v1.
2. **New table `push_subscriptions`**: `(id, userId, endpoint, p256dh, auth, createdAt, lastNotifiedAt)`. One row per browser/device.
3. **Subscribe flow**: `/team` page asks for notification permission on first visit; on grant, registers a service worker, POSTs the subscription to `/api/push/subscribe`.
4. **New tool `RemoteTrigger({title, body, deeplink?, urgency?})`**: lead-only initially (members can't push directly; they SendMessage the lead, which decides whether to notify). Inserts a `push_notifications` row + fires HTTP push to all the user's subscriptions via `web-push` library.
5. **Rate limiting**: max 5 pushes per user per hour. Lead-only enforcement + a per-user counter.
6. **Service worker**: receives the push, shows the system notification, on click navigates to `deeplink` (defaults to `/team`).

## File map

**Created**
- `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts` + tests
- `src/app/api/push/subscribe/route.ts`
- `src/app/api/push/unsubscribe/route.ts`
- `public/sw.js` (service worker)
- `src/components/push-permission-banner.tsx`
- `drizzle/0025_push_subscriptions.sql`
- `src/lib/db/schema/push-subscriptions.ts`
- `src/lib/push/send-push.ts` (wraps web-push lib, handles 410 Gone cleanup)
- `e2e/remote-trigger-smoke.spec.ts` (+ manual: real device check)

**Modified**
- `package.json` (add `web-push`)
- `src/tools/registry-team.ts`
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (add tool + "when to push" reference)
- `src/app/(app)/team/layout.tsx` (mount permission banner)
- `CLAUDE.md`

## Tasks (high-level)

1. Generate VAPID keypair; add `WEB_PUSH_PUBLIC_KEY` + `WEB_PUSH_PRIVATE_KEY` to env.
2. DB migration for `push_subscriptions`.
3. Service worker (`/public/sw.js`) handling `push` + `notificationclick` events.
4. Permission-banner component (asks for `Notification.requestPermission()`, registers SW, POSTs subscription).
5. `/api/push/subscribe` + `/unsubscribe` endpoints.
6. `send-push` lib helper that handles 410 Gone (subscription expired → delete row).
7. RemoteTrigger tool — lead-only, rate-limited, calls `send-push` for all user's subscriptions.
8. Coordinator AGENT.md — add tool + "when to push" reference (founder-set urgency rules: urgent threads, approval requests, error states).
9. Real-browser smoke (limited — push delivery requires a real browser session; CI smoke verifies the API + DB only).
10. Manual device check on launch — verify push lands on iOS Safari, Android Chrome, desktop Chrome, desktop Safari.

## Tradeoffs / risks

- **Browser support**: iOS Safari requires PWA install for web push. Without install: no push. Mitigation: detect install state in the banner, prompt for install when needed.
- **Notification fatigue**: founders will revoke permission if pushed too aggressively. Mitigation: rate-limit (5/hr) + `urgency` levels + founder-side "do not disturb" toggle.
- **VAPID key rotation**: hard once subscriptions exist. Plan for key versioning — store keyId on subscription row.
- **Service worker debugging is painful.** Plan an extra day for SW lifecycle bugs (caching, scope, update-on-deploy).
- **Privacy**: push payloads are encrypted end-to-end (libsodium); never log payload contents server-side beyond what's needed for retry.

## Estimate

5–7 days (1 dev). Service worker + cross-browser testing is the long tail.

## When to flesh out

When the team is generating drafts or asks the founder is missing for >24h. Trigger: support requests like "I missed an approval and the agent sat for a day." Build it before that becomes the norm.
