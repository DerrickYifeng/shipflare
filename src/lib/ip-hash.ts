import { createHmac } from 'node:crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:ip-hash');
let saltWarnLogged = false;

/**
 * SHA-256 hash an IP with the server-side `IP_HASH_SALT` so we can detect
 * "same source resubmitted" without storing raw IPs. Returns null when:
 *   - `IP_HASH_SALT` env var is unset (logs warn once per process)
 *   - the IP is the "unknown" sentinel (callers pass this when
 *     x-forwarded-for is missing)
 *
 * Generate the salt once per environment:
 *   openssl rand -hex 32
 */
export function hashIp(ip: string): string | null {
  if (!ip || !ip.trim() || ip === 'unknown') return null;

  const salt = process.env.IP_HASH_SALT;
  if (!salt || salt.trim() === '') {
    if (!saltWarnLogged) {
      log.warn('IP_HASH_SALT not set — IP hashing disabled');
      saltWarnLogged = true;
    }
    return null;
  }

  return createHmac('sha256', salt).update(ip).digest('hex');
}
