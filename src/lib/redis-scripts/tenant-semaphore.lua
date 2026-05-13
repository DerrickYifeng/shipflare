-- src/lib/redis-scripts/tenant-semaphore.lua
-- Atomic per-tenant in-flight semaphore.
--
-- KEYS[1] = inflight key, e.g. "inflight:agent:user-abc"
-- ARGV[1] = cap (integer)        — maximum concurrent slots
-- ARGV[2] = ttl seconds (integer) — slot dies if not released within this window
--                                   (re-set on every acquire so long-running jobs don't expire)
--
-- Returns: { acquired (0|1), current_count, cap }
--
-- If current >= cap → refuse, return {0, current, cap} (no mutation).
-- Else              → INCR + EXPIRE, return {1, newval, cap}.

local key = KEYS[1]
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key)) or 0

if current >= cap then
  return {0, current, cap}
end

local newval = redis.call('INCR', key)
redis.call('EXPIRE', key, ttl)
return {1, newval, cap}
