import type { ProductState } from './launch-phase';

/**
 * Per-state date validation rules. Used by:
 *  - POST /api/onboarding/commit (initial write)
 *  - POST /api/product/phase (Settings-driven update)
 *
 * Keep the two endpoints honest by sharing the rule set — frontend
 * can render the same error copy regardless of path.
 *
 * Rules:
 *   state='launching' → launchDate required, in [today+7d, today+90d]
 *   state='launched'  → launchedAt required, in [today-3y, today]
 *   state='mvp'       → launchedAt must be null; launchDate optional
 *                       and in [today+1d, today+365d]
 *
 * Past launchDate with state='mvp' is rejected so the UI cannot
 * silently persist a stale future date.
 */

const MS_PER_DAY = 86_400_000;

export interface LaunchDateInput {
  state: ProductState;
  launchDate: string | null;
  launchedAt: string | null;
}

export interface LaunchDateRuleError {
  field: 'launchDate' | 'launchedAt';
  message: string;
}

export function validateLaunchDates(
  input: LaunchDateInput,
  now: number = Date.now(),
): LaunchDateRuleError[] {
  const errors: LaunchDateRuleError[] = [];
  const launchDateMs = input.launchDate ? Date.parse(input.launchDate) : null;
  const launchedAtMs = input.launchedAt ? Date.parse(input.launchedAt) : null;

  if (input.state === 'launching') {
    if (launchDateMs == null) {
      errors.push({
        field: 'launchDate',
        message: 'state=launching requires launchDate',
      });
    } else {
      const minMs = now + 7 * MS_PER_DAY;
      const maxMs = now + 90 * MS_PER_DAY;
      if (launchDateMs < minMs || launchDateMs > maxMs) {
        errors.push({
          field: 'launchDate',
          message: 'state=launching requires launchDate in [today+7d, today+90d]',
        });
      }
    }
  } else if (input.state === 'launched') {
    if (launchedAtMs == null) {
      errors.push({
        field: 'launchedAt',
        message: 'state=launched requires launchedAt',
      });
    } else {
      const minMs = now - 3 * 365 * MS_PER_DAY;
      const maxMs = now;
      if (launchedAtMs < minMs || launchedAtMs > maxMs) {
        errors.push({
          field: 'launchedAt',
          message: 'state=launched requires launchedAt in [today-3y, today]',
        });
      }
    }
  } else {
    // state === 'mvp'
    if (launchedAtMs != null) {
      errors.push({
        field: 'launchedAt',
        message: 'state=mvp requires launchedAt=null',
      });
    }
    if (launchDateMs != null) {
      const minMs = now + 1 * MS_PER_DAY;
      const maxMs = now + 365 * MS_PER_DAY;
      if (launchDateMs < minMs || launchDateMs > maxMs) {
        errors.push({
          field: 'launchDate',
          message:
            'state=mvp requires launchDate null or in [today+1d, today+365d]',
        });
      }
    }
  }

  return errors;
}
