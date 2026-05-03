import { test as base, expect } from '@playwright/test';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import {
  seedSession,
  seedTeam,
  seedTeamMessage,
  getTestDb,
} from '../fixtures/db';
import * as schema from '../../src/lib/db/schema';

// playwright.config.ts also loads this, but the file order between
// fixture import and spec evaluation isn't deterministic, so be safe.
config({ path: '.env.local' });

/**
 * Admin /admin/team-runs end-to-end smoke. Verifies the Phase G rewrite:
 *   - List page renders with the per-request shape (no team_runs table)
 *   - ownerEmail is preserved from the user's recent enhancement
 *   - Trace column shows truncated request ids
 *   - Detail page reachable from a row click; renders header + activity
 *
 * The spec attaches to the EXISTING admin user (the one whose email is
 * the first entry in ADMIN_EMAILS / SUPER_ADMIN_EMAIL — the real
 * developer running the suite). We don't seed a new user because the
 * email-uniqueness constraint clashes with the live admin row, and we
 * don't cleanup the user because they're real. We cleanup only the
 * seeded session + team + messages so the dev DB stays tidy.
 *
 * If no admin user exists in the local DB yet, the fixture marks the
 * spec as skipped — same shape as the controller's "no historical data"
 * skip pattern, so this still won't gate commits when the DB is empty.
 */

interface AdminFixtures {
  adminUser: { id: string; email: string };
  adminPage: import('@playwright/test').Page;
  // Cleanup hooks tracked per-test so multiple specs in this file
  // don't trample each other.
  cleanupTeamIds: string[];
  cleanupSessionTokens: string[];
}

const adminEmails = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const test = base.extend<AdminFixtures>({
  adminUser: async ({}, use) => {
    if (adminEmails.length === 0) {
      throw new Error(
        'ADMIN_EMAILS env var is empty — set it in .env.local before running this spec',
      );
    }
    const db = getTestDb();
    // Look up the admin user that the layout's `isAdminEmail` will
    // recognize. This row exists in dev because the developer signed in
    // via GitHub at least once; in fresh CI environments it won't, in
    // which case we skip these specs (the dev signs in once + reruns).
    const [row] = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, adminEmails[0]))
      .limit(1);

    if (!row || !row.email) {
      test.skip(
        true,
        `admin user ${adminEmails[0]} is not in the local DB yet — sign in once before running this spec`,
      );
      // Unreachable after skip(), but TS narrowing wants a value.
      await use({ id: '', email: '' });
      return;
    }
    await use({ id: row.id, email: row.email });
  },

  cleanupTeamIds: async ({}, use) => {
    const ids: string[] = [];
    await use(ids);
    if (ids.length > 0) {
      const db = getTestDb();
      // Cascade deletes covered messages, but explicit cleanup keeps
      // the local DB tidy and means a re-run of this spec doesn't
      // double-count seeded rows in the list-page assertions.
      for (const teamId of ids) {
        await db
          .delete(schema.teamMessages)
          .where(eq(schema.teamMessages.teamId, teamId));
        await db
          .delete(schema.teamMembers)
          .where(eq(schema.teamMembers.teamId, teamId));
        await db.delete(schema.teams).where(eq(schema.teams.id, teamId));
      }
    }
  },

  cleanupSessionTokens: async ({}, use) => {
    const tokens: string[] = [];
    await use(tokens);
    if (tokens.length > 0) {
      const db = getTestDb();
      for (const t of tokens) {
        await db
          .delete(schema.sessions)
          .where(eq(schema.sessions.sessionToken, t));
      }
    }
  },

  adminPage: async (
    { page, adminUser, cleanupSessionTokens },
    use,
  ) => {
    if (!adminUser.id) {
      // Fixture chain bailed via test.skip in adminUser. Hand the page
      // back unmodified — the test won't run.
      await use(page);
      return;
    }
    const sessionToken = await seedSession(adminUser.id);
    cleanupSessionTokens.push(sessionToken);
    await page.context().addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await use(page);
  },
});

test.describe('/admin/team-runs (per-request view)', () => {
  test('list page renders header + heading copy', async ({ adminPage }) => {
    await adminPage.goto('/admin/team-runs');
    await expect(adminPage.getByText('Observability')).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: 'Recent requests' }),
    ).toBeVisible();
  });

  test('seeded request appears with ownerEmail and Trace columns', async ({
    adminPage,
    adminUser,
    cleanupTeamIds,
  }) => {
    const teamName = `Phase G Smoke ${Date.now()}`;
    const { teamId, coordinatorId } = await seedTeam(adminUser.id, {
      name: teamName,
    });
    cleanupTeamIds.push(teamId);

    const requestId = crypto.randomUUID();
    const db = getTestDb();
    await db.insert(schema.teamMessages).values({
      id: requestId,
      teamId,
      type: 'user_prompt',
      messageType: 'message',
      fromMemberId: null,
      toAgentId: coordinatorId,
      content: 'Plan a launch sweep for next week.',
      createdAt: new Date(),
    });
    await seedTeamMessage(teamId, {
      runId: requestId,
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'agent_text',
      content: 'On it — kicking off the planner.',
    });

    await adminPage.goto('/admin/team-runs');

    // Team name visible (joined from teams.name). Use a unique-per-run
    // name so we don't get false positives from prior real data.
    await expect(adminPage.getByText(teamName)).toBeVisible();
    // ownerEmail (joined from users.email) renders under the team name.
    // first() because the admin's email may also appear elsewhere (e.g.,
    // their other real teams) on the same list.
    await expect(adminPage.getByText(adminUser.email).first()).toBeVisible();
    // Trace column shows the truncated request id (first 8 chars).
    await expect(
      adminPage.getByText(requestId.slice(0, 8), { exact: false }).first(),
    ).toBeVisible();
  });

  test('detail page renders the request header + activity timeline', async ({
    adminPage,
    adminUser,
    cleanupTeamIds,
  }) => {
    const { teamId, coordinatorId } = await seedTeam(adminUser.id, {
      name: `Phase G Detail ${Date.now()}`,
    });
    cleanupTeamIds.push(teamId);

    const requestId = crypto.randomUUID();
    const db = getTestDb();
    await db.insert(schema.teamMessages).values({
      id: requestId,
      teamId,
      type: 'user_prompt',
      messageType: 'message',
      fromMemberId: null,
      toAgentId: coordinatorId,
      content: 'Detail-page smoke goal.',
      createdAt: new Date(),
    });
    await seedTeamMessage(teamId, {
      runId: requestId,
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'agent_text',
      content: 'Detail-page smoke response.',
    });

    await adminPage.goto(`/admin/team-runs/${requestId}`);

    await expect(
      adminPage.getByRole('heading', { name: 'Request' }),
    ).toBeVisible();
    await expect(adminPage.getByText('Detail-page smoke goal.')).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: /^Conversation/ }),
    ).toBeVisible();
    await expect(
      adminPage.getByText('Detail-page smoke response.'),
    ).toBeVisible();
    await expect(
      adminPage.getByRole('link', { name: /back to list/ }),
    ).toBeVisible();
  });

  test('non-existent request id 404s instead of rendering an empty header', async ({
    adminPage,
  }) => {
    // Random uuid that doesn't match any user_prompt row; the detail
    // page's where-clause is restrictive (type='user_prompt' AND
    // messageType='message' AND fromMemberId IS NULL AND toAgentId
    // IS NOT NULL) so this notFound()s cleanly.
    const fakeId = crypto.randomUUID();
    const response = await adminPage.goto(`/admin/team-runs/${fakeId}`);
    expect(response?.status()).toBe(404);
  });
});
