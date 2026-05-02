import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';
import { plans } from './plans';
import { launchPhaseEnum } from './strategic-paths';

export const planItemKindEnum = pgEnum('plan_item_kind', [
  'content_post',
  'content_reply',
  'email_send',
  'interview',
  'setup_task',
  'launch_asset',
  'runsheet_beat',
  'metrics_compute',
  'analytics_summary',
]);

export const planItemStateEnum = pgEnum('plan_item_state', [
  'planned',
  // `drafting` — claimed by the plan-execute-sweeper for content_post
  // batch drafting (Phase J Task 2). The sweeper flips planned → drafting
  // atomically so concurrent ticks don't double-dispatch a team-run, then
  // hands the row to content-manager(post_batch); `draft_post` advances
  // the row to `drafted` once persisted.
  'drafting',
  'drafted',
  'ready_for_review',
  'approved',
  'executing',
  'completed',
  'skipped',
  'failed',
  'superseded',
  'stale',
]);

export const planItemUserActionEnum = pgEnum('plan_item_user_action', [
  'auto',
  'approve',
  'manual',
]);

/**
 * Polymorphic plan item. One row per concrete action the Tactical Planner
 * schedules (content post, reply, email, interview, setup task, etc.).
 * `kind` + `params` carry the type-specific payload; `skillName` routes
 * to the atomic skill that runs during the `draft` / `execute` phases of
 * the plan-execute queue.
 */
export const planItems = pgTable(
  'plan_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),

    kind: planItemKindEnum('kind').notNull(),
    state: planItemStateEnum('state').notNull().default('planned'),
    userAction: planItemUserActionEnum('user_action').notNull(),

    phase: launchPhaseEnum('phase').notNull(),
    channel: text('channel'),
    scheduledAt: timestamp('scheduled_at', { mode: 'date' }).notNull(),

    skillName: text('skill_name'),
    params: jsonb('params').notNull(),
    output: jsonb('output'),

    title: text('title').notNull(),
    description: text('description'),

    completedAt: timestamp('completed_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('plan_items_user_state_scheduled_idx').on(
      t.userId,
      t.state,
      t.scheduledAt,
    ),
    index('plan_items_plan_idx').on(t.planId),
    index('plan_items_user_kind_state_idx').on(t.userId, t.kind, t.state),
  ],
);
