/**
 * PlanTab — 7-day calendar view of plan_items.
 *
 * Mirrors Railway's CalendarContent at src/app/(app)/calendar/calendar-content.tsx
 * but adapted for CF:
 *   - Railway: fetches `/api/calendar?weekStart=` against Postgres.
 *   - CF: queries CMO MCP `queryPlanItems` and buckets client-side.
 *
 * Data-model gaps vs Railway (CF doesn't have these columns on plan_items):
 *   - `title`         → fall back to a humanized skill+channel label.
 *   - `kind`          → derive from skill name (heuristic).
 *   - `phase`/`sortOrder` → not used (items sort by scheduled_for then id).
 *   - `state`         → mapped from `status`.
 *   - `dueDate`       → derived from `scheduled_for` (timestamp ms → UTC date).
 *
 * Items with no `scheduled_for` are skipped — they don't belong on a
 * calendar grid. The simpler list view of those lives in /briefing
 * (Today tab) if we want to surface them later.
 */

"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface PlanItem {
  id: string;
  skill: string;
  channel: string;
  status: string;
  owner_role: string;
  scheduled_for: number | null;
  started_at: number | null;
  completed_at: number | null;
  params_json: string | null;
}

interface CalendarItem {
  id: string;
  kind: string;
  state: string;
  channel: string | null;
  title: string;
}

interface CalendarDay {
  date: string; // YYYY-MM-DD (UTC)
  items: CalendarItem[];
}

interface CalendarView {
  weekStart: Date; // Monday UTC
  weekEnd: Date; // exclusive — next Monday UTC
  days: CalendarDay[];
  totals: { scheduled: number; completed: number; skipped: number };
}

interface State {
  loading: boolean;
  error: string | null;
  view: CalendarView | null;
  weekOffset: number; // 0 = current week, ±N = offset weeks
}

/* ── Constants ─────────────────────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;

// Skills that map cleanly to a short calendar kind label.
const SKILL_KIND: Record<string, string> = {
  "draft-single-post": "content_post",
  "draft-single-reply": "content_reply",
  "find-threads-via-xai": "discover",
  "find-threads": "discover",
  "validating-draft": "review",
  "drafting-post": "content_post",
  "drafting-reply": "content_reply",
  "tactical-planner": "plan",
  "strategic-planner": "plan",
};

const KIND_LABEL: Record<string, string> = {
  content_post: "Post",
  content_reply: "Reply",
  discover: "Discover",
  review: "Review",
  plan: "Plan",
  email_send: "Email",
  interview: "Interview",
  setup_task: "Task",
  launch_asset: "Asset",
  runsheet_beat: "Beat",
  metrics_compute: "Metrics",
  analytics_summary: "Analytics",
};

const STATE_COLORS: Record<string, string> = {
  planned: "var(--sf-fg-3)",
  pending: "var(--sf-fg-3)",
  drafting: "var(--sf-warning)",
  drafted: "var(--sf-warning)",
  ready: "var(--sf-accent)",
  ready_for_review: "var(--sf-accent)",
  approved: "var(--sf-accent)",
  executing: "var(--sf-accent)",
  in_progress: "var(--sf-warning)",
  completed: "var(--sf-success)",
  skipped: "var(--sf-fg-3)",
  failed: "var(--sf-error)",
  superseded: "var(--sf-fg-3)",
  stale: "var(--sf-fg-3)",
};

/* ── Helpers ───────────────────────────────────────────────────────── */

/** Monday-of-week UTC for the given date. */
function mondayUtc(d: Date): Date {
  const utc = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dow = utc.getUTCDay(); // 0=Sun
  const offset = dow === 0 ? -6 : 1 - dow;
  utc.setUTCDate(utc.getUTCDate() + offset);
  return utc;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toLocaleDateString("en-CA");
}

function formatDayHeader(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatWeekRange(start: Date, end: Date): string {
  const last = new Date(end.getTime() - MS_PER_DAY);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  return `${start.toLocaleDateString("en-US", opts)} – ${last.toLocaleDateString("en-US", opts)}`;
}

/** Try to extract a human title from skill + params_json + channel. */
function deriveTitle(item: PlanItem): string {
  if (item.params_json) {
    try {
      const params = JSON.parse(item.params_json) as Record<string, unknown>;
      const fromParams =
        (typeof params.title === "string" && params.title) ||
        (typeof params.topic === "string" && params.topic) ||
        (typeof params.query === "string" && params.query) ||
        (typeof params.subject === "string" && params.subject);
      if (fromParams) return fromParams;
    } catch {
      // ignore — fall through to skill label
    }
  }
  const skillLabel = item.skill.replace(/[-_]/g, " ");
  return item.channel ? `${skillLabel} · ${item.channel}` : skillLabel;
}

function deriveKind(item: PlanItem): string {
  return SKILL_KIND[item.skill] ?? item.skill;
}

function buildView(items: PlanItem[], weekOffset: number): CalendarView {
  const now = new Date();
  const baseMonday = mondayUtc(now);
  const weekStart = new Date(
    baseMonday.getTime() + weekOffset * 7 * MS_PER_DAY,
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * MS_PER_DAY);

  const byDay = new Map<string, CalendarItem[]>();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekStart.getTime() + i * MS_PER_DAY);
    byDay.set(toYmd(d), []);
  }

  let scheduled = 0;
  let completed = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.scheduled_for === null) continue;
    if (item.status === "superseded" || item.status === "stale") continue;
    const d = new Date(item.scheduled_for);
    if (d < weekStart || d >= weekEnd) continue;
    const key = toYmd(d);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    bucket.push({
      id: item.id,
      kind: deriveKind(item),
      state: item.status,
      channel: item.channel || null,
      title: deriveTitle(item),
    });
    if (item.status === "completed") completed += 1;
    else if (item.status === "skipped") skipped += 1;
    else scheduled += 1;
  }

  const days: CalendarDay[] = Array.from(byDay.entries()).map(
    ([date, dayItems]) => ({ date, items: dayItems }),
  );

  return {
    weekStart,
    weekEnd,
    days,
    totals: { scheduled, completed, skipped },
  };
}

/* ── Component ─────────────────────────────────────────────────────── */

export function PlanTab() {
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    view: null,
    weekOffset: 0,
  });
  const clientRef = useRef<CmoClient | null>(null);
  const rawItemsRef = useRef<PlanItem[]>([]);

  // Fetch once on mount; re-bucket client-side on week change.
  useEffect(() => {
    let cancelled = false;

    createCmoClient()
      .then(async (c) => {
        if (cancelled) {
          void c.close();
          return;
        }
        clientRef.current = c;
        try {
          const items = await c.queryPlanItems<PlanItem>({ limit: 500 });
          if (cancelled) return;
          rawItemsRef.current = items;
          setState((s) => ({
            ...s,
            loading: false,
            view: buildView(items, s.weekOffset),
          }));
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, loading: false, error: msg }));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, loading: false, error: msg }));
      });

    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const goWeek = useCallback((delta: number) => {
    setState((s) => {
      const next = s.weekOffset + delta;
      return { ...s, weekOffset: next, view: buildView(rawItemsRef.current, next) };
    });
  }, []);

  if (state.error) {
    return (
      <div
        className="sf-body"
        style={{ padding: "28px clamp(16px, 3vw, 32px)", color: "var(--sf-error, #c33)" }}
      >
        {state.error}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--sf-bg-primary)",
        minHeight: "calc(100vh - 200px)",
      }}
    >
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: "100%",
          margin: "0 auto",
          padding: "24px 16px 48px",
          boxSizing: "border-box",
        }}
      >
        {/* Week navigation */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
            gap: 8,
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goWeek(-1)}
            disabled={state.loading}
          >
            ← Prev
          </Button>

          <div style={{ textAlign: "center", flex: 1 }}>
            {state.view && (
              <>
                <p
                  style={{
                    fontSize: 15,
                    letterSpacing: "-0.3px",
                    fontWeight: 600,
                    color: "var(--sf-fg-1)",
                    margin: 0,
                  }}
                >
                  {formatWeekRange(state.view.weekStart, state.view.weekEnd)}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    letterSpacing: "-0.12px",
                    color: "var(--sf-fg-3)",
                    marginTop: 2,
                    margin: 0,
                  }}
                >
                  {state.view.totals.scheduled} scheduled ·{" "}
                  {state.view.totals.completed} completed
                  {state.view.totals.skipped > 0
                    ? ` · ${state.view.totals.skipped} skipped`
                    : ""}
                </p>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => goWeek(1)}
            disabled={state.loading}
          >
            Next →
          </Button>
        </div>

        {state.loading ? (
          <SkeletonWeek />
        ) : !state.view || state.view.days.every((d) => d.items.length === 0) ? (
          <EmptyState
            title="Nothing scheduled this week"
            hint="Plan items scheduled by the team will appear here."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            {state.view.days.map((day) => (
              <DaySection key={day.date} day={day} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/* ── DaySection ────────────────────────────────────────────────────── */

function DaySection({ day }: { day: CalendarDay }) {
  const today = isToday(day.date);
  const isEmpty = day.items.length === 0;
  const doneCount = day.items.filter((i) => i.state === "completed").length;

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.2px",
            color: today ? "var(--sf-accent)" : "var(--sf-fg-1)",
            margin: 0,
          }}
        >
          {formatDayHeader(day.date)}
          {today && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
                color: "var(--sf-accent)",
                background: "var(--sf-accent-light, rgba(0,113,227,0.1))",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              Today
            </span>
          )}
        </h2>
        {!isEmpty && (
          <span
            style={{
              fontSize: 11,
              color: "var(--sf-fg-3)",
              marginLeft: "auto",
            }}
          >
            {doneCount}/{day.items.length}
          </span>
        )}
      </div>

      {isEmpty ? (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            border: "1px dashed var(--sf-border)",
            fontSize: 12,
            color: "var(--sf-fg-3)",
          }}
        >
          No items
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {day.items.map((item) => (
            <PlanItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ── PlanItemRow ───────────────────────────────────────────────────── */

function PlanItemRow({ item }: { item: CalendarItem }) {
  const isCompleted = item.state === "completed";
  const isSkipped = item.state === "skipped";
  const dotColor = STATE_COLORS[item.state] ?? "var(--sf-fg-3)";

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    background: "var(--sf-bg-secondary)",
    border: "1px solid var(--sf-border)",
  };

  return (
    <div style={rowStyle}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          letterSpacing: "-0.224px",
          color: isCompleted || isSkipped ? "var(--sf-fg-3)" : "var(--sf-fg-1)",
          textDecoration: isCompleted ? "line-through" : undefined,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {item.title}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {item.channel && (
          <span
            style={{
              fontSize: 11,
              letterSpacing: "-0.1px",
              color: "var(--sf-fg-3)",
              fontFamily: "var(--sf-font-mono)",
            }}
          >
            {item.channel}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            letterSpacing: "-0.1px",
            color: "var(--sf-fg-3)",
            background: "var(--sf-bg-tertiary)",
            borderRadius: 4,
            padding: "2px 6px",
          }}
        >
          {KIND_LABEL[item.kind] ?? item.kind}
        </span>
      </div>
    </div>
  );
}

/* ── SkeletonWeek ──────────────────────────────────────────────────── */

function SkeletonWeek() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i}>
          <div
            style={{
              height: 14,
              width: 120,
              borderRadius: 4,
              background: "var(--sf-bg-tertiary)",
              marginBottom: 8,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Array.from({ length: 2 }).map((_, j) => (
              <div
                key={j}
                style={{
                  height: 40,
                  borderRadius: 8,
                  background: "var(--sf-bg-secondary)",
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
