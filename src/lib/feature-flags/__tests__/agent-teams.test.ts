import { describe, it, expect, afterEach } from 'vitest';
import { isAgentTeamsEnabledForTeam } from '@/lib/feature-flags/agent-teams';

describe('isAgentTeamsEnabledForTeam', () => {
  const originalEnv = process.env.SHIPFLARE_AGENT_TEAMS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SHIPFLARE_AGENT_TEAMS;
    else process.env.SHIPFLARE_AGENT_TEAMS = originalEnv;
  });

  it('returns false when env var is unset', async () => {
    delete process.env.SHIPFLARE_AGENT_TEAMS;
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
  });

  it('returns true when env var is "1"', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = '1';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(true);
  });

  it('returns true when env var is "true"', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = 'true';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(true);
  });

  it('returns false when env var is "0" / "false" / other', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = '0';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
    process.env.SHIPFLARE_AGENT_TEAMS = 'false';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
    process.env.SHIPFLARE_AGENT_TEAMS = 'maybe';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
  });
});
