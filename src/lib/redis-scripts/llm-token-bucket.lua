-- src/lib/redis-scripts/llm-token-bucket.lua
-- Atomic two-level token bucket — tenant bucket AND global bucket, gated in
-- one Lua call so a tenant can never be billed against the global budget
-- after the global already refused (and vice versa).
--
-- KEYS[1] = tenant bucket key,  e.g. "llm:tenant:user-abc"
-- KEYS[2] = global bucket key,  e.g. "llm:global:anthropic"
-- ARGV[1] = tenant cap          (integer)
-- ARGV[2] = tenant refill/sec   (float; e.g. 1000 RPM = 16.67/sec)
-- ARGV[3] = global cap          (integer)
-- ARGV[4] = global refill/sec   (float)
-- ARGV[5] = now (ms)            (integer; caller passes Date.now())
-- ARGV[6] = cost                (integer; usually 1 — one request)
--
-- Returns on allow: { 1, tenant_remaining, global_remaining }
-- Returns on deny:  { 0, "tenant"|"global"|"config", retry_ms }
--
-- Tokens are stored as FLOAT under the hash field 't' (e.g. 4.7). The
-- last-refill timestamp lives under 'ts' (ms). On global-deny after a
-- tenant-allow, we MUST refund the tenant token we just consumed — we use
-- HINCRBYFLOAT (HINCRBY would error because 't' is a float string) AND we
-- must restore the pre-refill `ts` so the next call doesn't double-credit
-- the refilled interval (the refund already restored tokens covering that
-- window; advancing `ts` would credit it a second time on the next acquire).
--
-- TTL of 3600s keeps abandoned tenants from polluting Redis forever.

local function refill(key, cap, rate_per_sec, now_ms, cost)
  local data = redis.call('HMGET', key, 't', 'ts')
  local tokens = tonumber(data[1])
  local last = tonumber(data[2])
  if tokens == nil or last == nil then
    -- Cold start: full bucket, last-refill is now.
    tokens = cap
    last = now_ms
  end
  -- Snapshot the pre-refill `ts` so the caller can restore it on a refund
  -- path (see global-deny branch in main). Without this, refunding tokens
  -- but leaving `ts = now_ms` lets the next acquire re-credit the same
  -- elapsed interval on top of the refund — double-credit.
  local prior_ts = last
  local elapsed_sec = (now_ms - last) / 1000.0
  if elapsed_sec < 0 then elapsed_sec = 0 end
  tokens = math.min(cap, tokens + elapsed_sec * rate_per_sec)
  if tokens < cost then
    local need = cost - tokens
    -- Guard against zero/negative refill rate (would otherwise divide-by-zero
    -- and return inf/nan). Treat as "never refills" → return a long retry.
    local retry_ms
    if rate_per_sec <= 0 then
      retry_ms = 60000
    else
      retry_ms = math.ceil((need / rate_per_sec) * 1000)
    end
    -- Persist the refilled-but-not-consumed token state so the next caller
    -- sees the up-to-date balance (and a stable ts for the elapsed math).
    redis.call('HMSET', key, 't', tokens, 'ts', now_ms)
    redis.call('EXPIRE', key, 3600)
    return {false, tokens, retry_ms, prior_ts}
  end
  tokens = tokens - cost
  redis.call('HMSET', key, 't', tokens, 'ts', now_ms)
  redis.call('EXPIRE', key, 3600)
  return {true, tokens, 0, prior_ts}
end

-- Defensive coercion: nil/non-numeric ARGV becomes a safe default that refuses
-- the call rather than crashing the script (which would fail-open in the TS
-- wrapper — silently bypassing the rate limiter).
local tenant_cap = tonumber(ARGV[1]) or 0
local tenant_rate = tonumber(ARGV[2]) or 0
local global_cap = tonumber(ARGV[3]) or 0
local global_rate = tonumber(ARGV[4]) or 0
local now_ms = tonumber(ARGV[5]) or 0
local cost = tonumber(ARGV[6]) or 1

-- Defensive guards: caps <= 0 mean "no budget configured / typo / disabled".
-- Refuse immediately under the appropriate scope rather than divide-by-zero
-- in the refill math.
if tenant_cap <= 0 then
  return {0, 'tenant', 0}
end
if global_cap <= 0 then
  return {0, 'global', 0}
end
-- A `cost` larger than the cap can never succeed — surface this as a
-- distinct scope so callers can log a config_error rather than retry forever.
if cost > tenant_cap or cost > global_cap then
  return {0, 'config', 0}
end

local t = refill(KEYS[1], tenant_cap, tenant_rate, now_ms, cost)
if not t[1] then
  return {0, 'tenant', t[3]}
end

local g = refill(KEYS[2], global_cap, global_rate, now_ms, cost)
if not g[1] then
  -- Refund the tenant slot we just took. Two writes are required:
  --   1. HINCRBYFLOAT restores the consumed token. HINCRBYFLOAT (not HINCRBY)
  --      because the hash field 't' holds a float string (e.g. "4.7");
  --      HINCRBY would error with "value is not an integer".
  --   2. HSET restores `ts` to the pre-refill value (`t[4]` = prior_ts).
  --      Otherwise the refilled-and-restored interval would be credited a
  --      second time on the next acquire (double-credit bug).
  redis.call('HINCRBYFLOAT', KEYS[1], 't', cost)
  redis.call('HSET', KEYS[1], 'ts', t[4])
  return {0, 'global', g[3]}
end

return {1, t[2], g[2]}
