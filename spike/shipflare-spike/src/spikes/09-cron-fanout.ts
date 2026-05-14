import type { Env } from "../index";

// Spike #9 — Cron fan-out.
//
// Validates that wrangler `triggers.crons` fires the `scheduled()` Worker
// handler on schedule, and that the handler can fan out to a Durable
// Object instance. Phase 1 will use this exact shape for hourly inbound
// sweeps across active CMOs: cron tick → scheduled() → loop over active
// teams → `env.TEAM_DO.getByName(teamId).runSweep()`.
//
// The "fan-out" here is a single DO (`cron-target`) for spike simplicity;
// the production version will list active team ids from D1 and invoke
// each team's DO stub in parallel via `Promise.allSettled`.

export async function onCron(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Fan out: write a marker into SqliteDO so we can observe the tick.
  // `getByName` derives a deterministic DO id from a string — same name,
  // same DO instance, every tick.
  const stub = env.SQLITE_DO.getByName("cron-target");
  await stub.markCronTick(event.scheduledTime);
}

export default async function handler(
  _req: Request,
  env: Env,
): Promise<Response> {
  const stub = env.SQLITE_DO.getByName("cron-target");
  const markers = await stub.listCronMarkers();
  return Response.json({
    markerCount: markers.length,
    recent: markers.slice(0, 5),
    note: "Trigger cron in dev via: pnpm wrangler dev --test-scheduled, then curl 'http://localhost:8787/__scheduled?cron=*/1+*+*+*+*'",
  });
}
