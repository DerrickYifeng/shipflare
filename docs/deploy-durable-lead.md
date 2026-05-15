# Deploy runbook — Durable Lead Orchestrator (Phase D)

This runbook covers the one-time production cutover from the legacy
single-shot `agent-run` body (polling-drain) to the durable lead
orchestrator (`leadStep` + checkpoint + waiting_for + delayed re-enqueue).

The cutover is **gated by `ENABLE_DURABLE_LEAD=true` in the worker env**
and is reversible by flipping the flag back to `false` and restarting
workers — with one DESTRUCTIVE caveat: the backfill in step 6 marks
in-flight `running` / `resuming` rows as `failed`, and rolling back the
code path does NOT un-mark those rows. Plan accordingly.

---

## 1. Pre-deploy verification

Before scheduling the maintenance window, confirm:

- [ ] `ENABLE_DURABLE_LEAD` is currently unset OR `false` in the prod
      worker env. (`bun run -e 'console.log(process.env.ENABLE_DURABLE_LEAD)'`
      on the worker, or check Railway env vars.)
- [ ] `PG_POOL_MAX` is set to at least `30` (B1 raised the default in
      prod; older deploys still on the legacy `10` will exhaust the pool
      under durable load).
- [ ] `LLM_TENANT_RPM` and `LLM_GLOBAL_RPM` are set (B5 — hierarchical
      token bucket). Without them the per-call rate-limit returns
      fail-open and the durable path's longer step durations can drift
      tenants over their nominal RPM.
- [ ] Migration `0031_agent_runs_checkpoint_waiting_for.sql` has been
      applied. Verify with:
      ```sql
      \d agent_runs
      -- expect: checkpoint (jsonb), waiting_for (text[]), next_wake_at (timestamptz)
      ```
      D1 was deployed earlier in the Phase D chain (commit `3171b00`);
      if you've been deploying head-of-`dev` continuously the column
      already exists.
- [ ] `.auth/founder.json` exists for the post-deploy live smoke
      (deferred — A4/B8 blocker). If the founder-auth fixture isn't yet
      checked in, skip the live smoke step and rely on log signals +
      `/api/admin/queue-stats` instead.

---

## 2. Maintenance window timing

- Pick a **low-traffic window**. Avoid 13:00 UTC (daily-run cron) and any
  hour with active scheduled runs in `bullmq_repeat_jobs`.
- Expect **~5 minutes** of worker downtime end-to-end. Web traffic stays
  up — only the BullMQ worker pauses.
- Announce the window in `#ops` (or your team's equivalent) ~30 minutes
  beforehand.

---

## 3. Deploy procedure

Execute the steps in order. Do not skip the dry-run.

1. **Schedule the maintenance window.** Confirm low traffic on
   `/api/admin/queue-stats` — `priority.active`, `standard.active`, and
   `backfill.active` should all be in single digits before you begin.

2. **Pause BullMQ workers.** On Railway: scale the `worker` service to
   `0` replicas. Wait until in-flight jobs finish or time out (~2 min).
   Verify `/api/admin/queue-stats` shows `active=0` across all lanes.

3. **Apply DB migration (if not already done):**
   ```bash
   bun run scripts/run-migrations.ts
   ```
   D1 already migrated `0031_agent_runs_checkpoint_waiting_for.sql` on
   the dev environment; in prod, confirm the migration table marks 0031
   applied.

4. **Dry-run the backfill** (PREVIEW ONLY, no mutation):
   ```bash
   DATABASE_URL='<prod>' bun run scripts/backfill-agent-runs-checkpoint.ts
   ```
   The script prints per-row id + status for every affected row and a
   summary count. No `--commit` flag → no DB writes.

5. **Review the preview output.** Sanity-check:
   - "To fail" count is the number of `running` / `resuming` rows you
     expect to be in flight at the cutover. Typically 0-50.
   - "To set next_wake_at" count is the number of `sleeping` rows
     awaiting a scheduled wake. Typically 0-200.
   - The WARNING section (sleeping rows with NULL `sleep_until`) should
     be empty; if it isn't, those rows need manual triage **before**
     committing.

6. **Execute the backfill** (DESTRUCTIVE — fails in-flight runs):
   ```bash
   DATABASE_URL='<prod>' bun run scripts/backfill-agent-runs-checkpoint.ts --commit
   ```
   The script logs `✓ Marked N running/resuming rows as failed` and
   `✓ Set next_wake_at on M sleeping rows`. `shutdown_reason` is stamped
   `migration_to_durable_lead_2026_05` for forensics.

   Two row classes, two outcomes:
   - **running/resuming → failed.** Those conversations are lost.
     Acceptable: they were going to die on next worker restart anyway
     (the legacy body had no checkpoint, no resume path). The founder
     UI will show the in-flight teammate as failed with the migration
     `shutdown_reason`.
   - **sleeping → preserved.** `next_wake_at` is set to `sleep_until` so
     the row is structurally consistent with what the durable Sleep
     handler would have written. The pre-existing BullMQ delayed job
     (enqueued by `SleepTool` at sleep-time) is what actually resumes
     the row when its wake arrives — that job is still in Redis. The
     durable path will pick it up with `checkpoint: null`, replay the
     transcript via `loadAgentRunHistory`, and continue.

7. **Deploy new worker code.** Push or trigger a Railway deploy of the
   commit chain `3171b00` (D1) through `a6da7f6` (D5) and this runbook's
   commit (D6). On Railway: trigger redeploy of `worker` service.

8. **Set `ENABLE_DURABLE_LEAD=true`** in the `worker` service env. On
   Railway: Service → Variables → set `ENABLE_DURABLE_LEAD=true`.
   This is the actual cutover toggle.

9. **Resume BullMQ workers.** Scale the `worker` service back to N
   replicas (whatever steady-state was — typically 1-3). Wait ~30s for
   boot.

10. **Verify metrics endpoint.** Hit `/api/admin/queue-stats` and confirm:
    - Per-lane depths recover within 5 minutes (`backfill` lane likely
      surges first as reconcile-mailbox catches orphans, then drains).
    - No persistent `priority.failed` spike. A small bump is normal
      (rate-limit retries); a sustained climb is not.
    - At least one teammate shows `running` or `sleeping` status in the
      founder UI roster within 5 min of resume.

---

## 4. Rollback procedure

If the deploy goes wrong:

1. **Unset the flag.** On Railway: set `ENABLE_DURABLE_LEAD=false` in
   the `worker` service env. This forces `processAgentRun` back to the
   `runAgentTurn_legacy` body — the polling-drain implementation
   preserved verbatim as a one-flag escape hatch.
2. **Restart workers.** Railway: redeploy or restart the `worker` service.
3. **Wait for steady state.** Within 60s the legacy path should pick up
   the BullMQ delayed jobs and resume sleeping rows normally.

**Critical caveat — the backfill is not reversible:**
- Rows marked `failed` with `shutdown_reason='migration_to_durable_lead_2026_05'`
  stay failed. Rolling back restores the CODE PATH; the DATA is gone.
  Those teammate runs cannot be resumed. Founders will see them as
  failed in the activity feed.
- Rows where `next_wake_at` was set are unaffected by rollback — the
  legacy path ignores that column.

If you need to "un-fail" a specific row for a high-value customer,
hand-edit it back to `status='sleeping'` and clear `shutdown_reason`,
then trigger a fresh wake via `SendMessage` from the founder UI. The
transcript replay will surface whatever was already persisted to
`team_messages`; anything in-flight inside the worker process at cutover
time is unrecoverable.

---

## 5. Post-deploy verification

Within 30 minutes of resuming workers, confirm:

- [ ] `/api/admin/queue-stats` shows non-zero `completed` across lanes
      and `active + waiting` trending normal.
- [ ] Application logs show `leadStep` invocations without an error
      spike. Grep for `"durable"` and `"checkpoint"` — should be
      informational, not error-level.
- [ ] No spike in `LlmRateLimitedError` past baseline. The durable path
      changes step durations slightly; a sustained increase suggests
      `LLM_TENANT_RPM` / `LLM_GLOBAL_RPM` need tuning.
- [ ] A **fresh founder→lead chat interaction** completes end-to-end.
      Send a test message via the founder UI, watch for:
      - Lead status pill flips `sleeping` → `running` → `sleeping` (or
        spawns a teammate)
      - At least one teammate reply or task notification lands in the
        feed within 60s
      - No "thinking…" forever spinner on a DelegationCard
- [ ] D7 live-smoke (deferred — `.auth/founder.json` blocker). When the
      auth fixture lands, run the Playwright e2e from `__tests__/team/`
      against the prod URL to assert the full lead→teammate→lead cycle.

---

## 6. Known limitations

- **`shutdown_request` mailbox messages reach the lead's next `leadStep`
  call as regular content.** There is no `killed` discriminant in the
  decision union yet — flagged in D3. A founder hitting the per-teammate
  Cancel button POSTs `/api/team/agent/[agentId]/cancel`, which inserts
  a `shutdown_request` mailbox row; the lead observes it on next wake
  and the agent processes it as ordinary content. This works for graceful
  abort messaging but is not a hard kill. Hard kill requires a future
  ECC-level signal.
- **Memory subsystem callers bypass the LLM bucket.** `memory/retrieval`,
  `memory/run-summary`, and `memory/dream` make Anthropic calls outside
  the `createMessage` wrapper. B5's per-call rate limit doesn't see them.
  Volume is low (one per teammate-completion, one nightly per team) so
  this is documented-but-deferred rather than a launch blocker.
- **`agent-run.ts` is 2613 lines.** The legacy body (`runAgentTurn_legacy`)
  stays in-tree for one release as the rollback escape hatch. After two
  weeks of clean durable-path operation, a follow-up commit deletes the
  legacy body and drops the `ENABLE_DURABLE_LEAD` flag entirely.
- **`next_wake_at` is currently advisory.** The schema documents a
  scheduler that scans rows with `next_wake_at <= now()` and re-enqueues
  them, but that scheduler isn't built yet — the actual resume mechanism
  is the BullMQ delayed job enqueued by `SleepTool` at sleep-time. The
  backfill sets `next_wake_at` for forward-compatibility with the
  scheduler when it lands; setting it today doesn't cause any new wake
  behavior. If a `sleeping` row's BullMQ delayed job is lost (Redis
  flush, BullMQ purge), the row will stay sleeping forever until a
  founder `SendMessage` or `reconcile-mailbox` cron picks it up via the
  mailbox path.

---

## 7. Quick reference — commands

```bash
# Dry-run preview
DATABASE_URL='<prod>' bun run scripts/backfill-agent-runs-checkpoint.ts

# Commit the backfill
DATABASE_URL='<prod>' bun run scripts/backfill-agent-runs-checkpoint.ts --commit

# Apply schema migrations (if needed)
DATABASE_URL='<prod>' bun run scripts/run-migrations.ts

# Inspect post-deploy queue state
curl -H 'Authorization: Bearer $ADMIN_TOKEN' https://<prod>/api/admin/queue-stats
```
