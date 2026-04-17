# Backend 视角体检报告

## 1. 架构速览

**请求生命周期（自动化主链路）**
`POST /api/automation/run` (src/app/api/automation/run/route.ts:19) → `enqueueDiscovery` →
Redis/BullMQ `discovery` queue → `processDiscovery` (src/workers/processors/discovery.ts:27)
→ `runSkill(discovery)` fan-out per source → Anthropic API (via src/core/api-client.ts) →
persist `threads` → `enqueueContent` → `processContent` → `enqueueReview` → `processReview`
→ (可能 auto-approve) `enqueuePosting` → `processPosting` → Reddit/X API。
SSE 结果通过 Redis pub/sub (`shipflare:events:${userId}`) 回传到 `/api/events` (src/app/api/events/route.ts:15)。

**关键组件依赖**
- `src/workers/index.ts`: 14 个 BullMQ Worker + 8 个 cron repeatables（dream/discovery/monitor/content-calendar/metrics/analytics/todo-seed/code-diff）共享单个 ioredis connection。
- `src/core/skill-runner.ts` → `src/core/swarm.ts` (`SwarmCoordinator` + Semaphore) → `src/core/query-loop.ts` (`runAgent`) → `src/core/api-client.ts` (`createMessage` + retry + prompt-caching)。
- `src/lib/platform-deps.ts` 注入 `redditClient` / `xaiClient` / `xClient`；`src/lib/platform-config.ts` 提供 defaults/envGuard/charLimit。
- Drizzle + Postgres（`src/lib/db/schema/*.ts`），`channels.postHistory` / `products` / `threads` / `drafts` / `posts` / `activityEvents` / `todoItems` / `xMonitoredTweets` / `xContentCalendar` / `xTweetMetrics`。

---

## 2. Top 问题清单

### P0

#### P0-1  Reddit 集群里 N+1 写入 + 每个 thread 都先 SELECT 再 INSERT
- **位置**: src/workers/processors/discovery.ts:163-205
- **问题**: `for (const thread of allThreads)` 循环里每条都先 `db.select().from(threads).where(and(userId, externalId))` 再 `insert().returning()` 再 `enqueueContent`。单用户一次 discovery 可能有 30+ 线程 × (1 SELECT + 1 INSERT + 1 enqueue) = 90+ 次串行 roundtrip。大量用户 cron 时 Postgres 被 N+1 打爆。
- **影响面**: discovery 处理变慢 → content/review/posting 全链路延迟 → Today 页空白、自动化 "agent running" 长时间不出结果。
- **修复**: 改用 `onConflictDoNothing({ target: [userId, externalId] }).returning()`（需要 unique index on (userId, externalId)），一次 bulk insert，`.returning()` 拿到新建 id 列表再批量 `enqueueContent`。工作量 **S**。

#### P0-2  BullMQ 缺 `defaultJobOptions.removeOnComplete/removeOnFail`
- **位置**: src/lib/queue/index.ts:25-49 全部 `new Queue(...)` 调用；src/workers/index.ts:34-38 `BASE_OPTS`
- **问题**: 全项目 0 处出现 `removeOnComplete` / `removeOnFail` / `defaultJobOptions`（已 grep 确认）。BullMQ 默认会保留全部 completed/failed jobs，Redis 内存线性增长。加上 cron repeatables + engagement 每条 X 贴文 3 次延迟 job（src/workers/processors/posting.ts:155），长期必炸 Redis。
- **影响面**: Railway Redis 内存耗尽 → 所有 worker 一起停；/api/events SSE 也挂。
- **修复**: 给所有 `Queue` 加 `defaultJobOptions: { removeOnComplete: { count: 500, age: 24*3600 }, removeOnFail: { count: 2000, age: 7*24*3600 } }`。工作量 **S**。

#### P0-3  `/api/scan` SSE 完全未鉴权 + 对后端不限速
- **位置**: src/app/api/scan/route.ts:13-79
- **问题**: POST /api/scan 没 `await auth()`；任何人可传入任意 URL，触发 `runFullScan`，内部会：并行 Reddit + X discovery + community-discovery + community-intel 多个 agent + 多次 Anthropic/Grok 调用（几十万 token）。单次 scan 成本 $0.20+，恶意用户秒级触发等于直接把 API 账单刷爆。
- **影响面**: 成本失控、外部 API 配额耗尽、worker pool 被公共流量挤占。
- **修复**: 加 `auth()` 或 IP-based rate-limit（Redis INCR + EXPIRE），未登录每小时 ≤1 次；同一用户并发 ≤1。工作量 **S**。

#### P0-4  Reddit OAuth connect 的 `state` 参数不校验（无 CSRF 防护）
- **位置**: src/app/api/reddit/connect/route.ts:20-22（`// TODO: Store state in session/cookie for CSRF validation on callback`），src/app/api/reddit/callback/route.ts:14-47（没有 state 校验）
- **问题**: X 的 callback 正确做了 state 校验（src/app/api/x/callback/route.ts:27），但 Reddit 的没有。攻击者可以构造 callback URL 把自己的 Reddit 账户绑到受害者 session，之后受害者的 "Ship"/"Post" 会发到攻击者账号。
- **影响面**: 账户劫持；受信用户替攻击者刷内容。
- **修复**: connect 时写 httpOnly cookie `reddit_oauth_state=${state}`，callback 比较并删除。工作量 **S**。

#### P0-5  `channels.oauthTokenEncrypted` 在 `/api/drafts` 和 `automation/run` SELECT * 回显字段
- **位置**: src/app/api/automation/run/route.ts:43-46 `select().from(channels)`；src/workers/processors/posting.ts:67-71；src/app/api/x/targets/route.ts（同类）；src/lib/reddit-client.ts:86 instance 保存解密后的 `accessToken`
- **问题**: 多处 `select().from(channels)` 没用显式字段列表，返回 encrypted token 到 app 层。虽未直接 JSON.stringify 返给前端，但 `log.info(channel)` 一类随便打 log 就漏。worker 之间也到处传 channel 对象，增加泄漏面。
- **影响面**: 一次误用 log 就把加密 token（加上 ENC_KEY 如果被一起泄）搞出去。
- **修复**: 所有 API route 用 `select({ id, userId, platform, username, ... })` 显式白名单；worker 只在 `RedditClient.fromChannel` / `XClient.fromChannel` 内部读敏感字段。工作量 **M**。

#### P0-6  Worker 内循环串行 + 无 per-item try/catch，单点失败全批死
- **位置**: src/workers/processors/content-calendar.ts:94-179, src/workers/processors/monitor.ts:94-227, src/workers/processors/metrics.ts:84-108
- **问题**: monitor 的 for-loop 里，每个 target 先 `getUserTweets`（含 rate-limit check）再 per-tweet SELECT existing → INSERT → 再一次 `runSkill(replyScanSkill, { tweets: tweetsForReply })`。任何一个 target 的 fetch 异常要靠最外层 try/catch 兜底，但里面那个 `const existing = await db.select()` 是 per-tweet 串行 → 慢。并且 `processXMonitorForUser` 作为整体被 `processXMonitor` 外层 `for (const uid of userIds)` 串行调用（src/workers/processors/monitor.ts:402）。50 个用户 × 5 target × 10 tweet 的场景下一次 cron 可能跑 10+ 分钟，撞 30min lockDuration 之前 OK 但 Anthropic 调用堆积 → 429。
- **影响面**: 大规模后用户间互相阻塞，后面用户的 "监控到新推特 → reply 窗口 15 分钟" 会超时。
- **修复**: 外层 cron 的 per-user 循环改用 `Promise.allSettled` with concurrency limit (4-6)，或者干脆在 fan-out 阶段把 per-user 作为独立 job enqueue（让 BullMQ 的 concurrency 自然并行）。per-tweet 的 "exists?" 检查改成一次 `inArray(externalId, tweetIds)` 批量查询。工作量 **M**。

#### P0-7  `/api/scan` 公开端点绕过了 `createPlatformDeps` 平台抽象
- **位置**: src/core/pipelines/full-scan.ts:59-60, 100（`c.platform === 'reddit'`），250（`if (platform === 'reddit')`）
- **问题**: `runFullScan` 绕过 platform-deps，硬编码 `RedditClient.appOnly()` + `new XAIClient(...)`，并在合并阶段写 `platform === 'reddit'` 分支。加一个新平台要同时改 full-scan.ts + 三个硬编码 filter。违反 CLAUDE.md "Reference injection over agent hardcoding"。
- **影响面**: 新平台扩展成本高；/api/scan 行为和 worker 不一致（worker 用 createPlatformDeps，scan 自己另搞一套）。
- **修复**: 引入 `createPublicPlatformDeps(platforms: string[])` 或让 full-scan 遍历 `Object.keys(PLATFORMS)` + `isPlatformAvailable`。合并阶段把 per-platform intel 校验放进 `platform-config.ts` 的一个 hook。工作量 **M**。

### P1

#### P1-1  `processXMetrics` 里 `/^\d+$/.test(externalId)` 脆弱地区分 X vs Reddit post
- **位置**: src/workers/processors/metrics.ts:69-71
- **问题**: 靠 externalId 是否纯数字来判断平台，是事实绑定而非 schema 绑定。`posts` 表没 `platform` 列（或未使用），metrics 依赖字符串启发式。Reddit id base-36 里偶尔也可能纯数字。
- **修复**: 从 `threads.platform` join 过来筛选，或者给 `posts` 加 `platform` 字段并迁移。工作量 **S**。

#### P1-2  Worker cron fan-out 直接 loop，每次 cron 都 select 全表
- **位置**: src/workers/processors/discovery.ts:31-63, content-calendar.ts:223-252, monitor.ts:392-421, metrics.ts:145-162
- **问题**: 每个 cron repeatable job（6 个）跑起来都是 worker 内 for-loop → `await processXForUser(uid, ...)` 串行。这意味着 "monitor 所有 X 用户" 实际上在 worker 内单线程跑完，concurrency 配置（src/workers/index.ts:87）对 cron fan-out 没用（因为只有一个 job 在跑）。
- **修复**: cron job 只做 "发散"——`for each user: await enqueueMonitor({ userId, productId, platform })`，然后由正常 worker 按 `concurrency: 2/3` 并行。工作量 **S**（monitor 和 metrics 已是分发模式，content-calendar 和 discovery 也要对齐）。

#### P1-3  `UsageTracker._model` 只保留最后一次的 model，跨 model 计费不准
- **位置**: src/core/api-client.ts:388-398
- **问题**: `add()` 每次都 `this._model = model`，然后 `toSummary()` 用最后那个 model 的 pricing 一次性算整池 token 成本。如果 skill 里同时用 Haiku（subquery）+ Sonnet（主体），成本报表会系统性偏高或偏低。
- **影响面**: 成本 metric / `activityEvents.metadataJson.cost` 不可信，P0 预算告警无法成立。
- **修复**: 改为 per-model buckets；`toSummary()` 返回 `{ costUsd, byModel: { model: tokens+cost } }`。工作量 **S**。

#### P1-4  `extractJson` 手写深度计数器没跳过注释/特殊 escapes，失败后 prompt 补救再消耗一轮
- **位置**: src/core/query-loop.ts:374-429, :133-151
- **问题**: 1) parse 失败时直接把 `response.content` append 再发 "Please respond with ONLY raw JSON..."，多消耗 1 个 turn + cache miss 风险。2) Anthropic 2026 已支持 `output_config.format.type: 'json_schema'`（src/core/api-client.ts:189 已传），但 `extractJson` 那条 fallback 还在跑 → structured output 生效后不应再出现 prose。
- **修复**: 在 outputSchema 存在且模型 ≥ Sonnet 4.5 时，直接用 Anthropic 的 structured output；失败时走 fallback。工作量 **S**。

#### P1-5  SSE `/api/events` 每个连接 `new IORedis(...)`, heartbeat 永不退出
- **位置**: src/lib/redis/index.ts:30-35（createPubSubSubscriber），src/app/api/events/route.ts:25, :49-52（heartbeat setInterval 无上限）
- **问题**: 每个浏览器 tab 一个订阅连接。`cancel()` 里只 `subscriber.disconnect()`，但 heartbeat setInterval 在 `start()` 里定义，`cleanup` 被挂在 `(controller as unknown as { _cleanup }).` 但 `cancel()` 根本没调它——所以 heartbeat 在某些浏览器断开场景下泄漏。长会话累计 → 大量 ioredis 连接。
- **修复**: 在 `cancel()` 里调 `clearInterval(heartbeat)`；整体用 closure 变量即可。另外给订阅加 maxAge（30min 后主动关，前端重连）。工作量 **S**。

#### P1-6  `runAgent` 对 `outputSchema` parse 失败会"请模型重发"，但 cache prefix 已长出去一截
- **位置**: src/core/query-loop.ts:316-325
- **问题**: parse 失败后把完整 assistant 消息 + 纠错 user 消息 append 进 `messages`，下一轮还会 `addMessageCacheBreakpoint`。由于 message 后缀变化，prompt cache 利用率下降；高频出现会把 skill cost 放大 1.3-1.5x。
- **修复**: 纠错 retry 限制为 1 次（目前是到 maxTurns），并把纠错 prompt 单独 system append 而非 user message，以保持 message prefix 稳定。工作量 **S**。

#### P1-7  `/api/today` 每次都先 UPDATE expired（无 WHERE 索引保护），再一个 4-way JOIN
- **位置**: src/app/api/today/route.ts:19-29, :32-79, :94-117
- **问题**: 每次 GET 先 `UPDATE todoItems SET status='expired' WHERE userId AND status='pending' AND expiresAt <= now`——用户每刷新一次 Today 页都跑一次这个扫描写。紧接着一个 `todoItems LEFT JOIN drafts LEFT JOIN threads LEFT JOIN xContentCalendar`（4 张表）+ `CASE WHEN` 排序，再跑两个 aggregate。冷启动慢。
- **修复**: 1) 把 expire 移到 worker cron (每 5 min) 或 DB trigger；GET 端用 `WHERE expiresAt > now` 过滤即可；2) 确保 `todoItems(userId, status, priority)` 复合索引存在；3) timezone 计算（`getLocalDayStart`）太复杂且每次请求算 4 遍，缓存在 prefs 加载时。工作量 **M**。

#### P1-8  `skill-loader.ts` 每次 processor 启动都 sync readFileSync 整个 references 目录
- **位置**: src/core/skill-loader.ts:138-160；各 processor 顶层 `const postingSkill = loadSkill(...)`（如 src/workers/processors/posting.ts:22, monitor.ts:33, content-calendar.ts:28）
- **问题**: loadSkill 本身放顶层还 OK，但 skill-runner 在 `runSkill` 里每次都做 `loadAgentFromFile(agentPath, registry)`（src/core/skill-runner.ts:111）——每个 agent 调用重新 parse .md 文件 + rebuild tool registry。热路径中 sync fs + yaml parse，浪费且阻塞事件循环。
- **修复**: 在 skill-loader 层做 `Map<string, AgentConfig>` 缓存（modtime-aware）；或者预加载所有 agents 到 registry。工作量 **S**。

#### P1-9  `engagement.ts` 还在用旧的 `@/bridge/agent-runner` 而非 `@/core/query-loop`
- **位置**: src/workers/processors/engagement.ts:14-15（`import { runAgent, createToolContext } from '@/bridge/agent-runner'`）
- **问题**: 其它 processor 已迁到 `@/core`（skill-runner），engagement 是唯一的历史遗留，享受不到 skill references 注入、cache-safe fork、idle timeout 等新特性。
- **修复**: 改为 `loadSkill('engagement-monitor')` + `runSkill({ skill, input, deps })`。工作量 **S**。

#### P1-10  Worker / API 共享单个 ioredis connection 但 auth 路径 + DB query 都 inline 在 SSE
- **位置**: src/lib/redis/index.ts:13-24（全进程 `_redis` singleton 被 BullMQ、publishEvent、SSE、监听 sinceId 都在用）
- **问题**: `getRedis()` 单 connection 同时被 BullMQ (blocking BRPOP)、publishEvent (write)、metrics sinceId getter 用。BullMQ 推荐 publisher 和 consumer 连接分离；长 blocking 命令可能让普通 publish/get 排队。监控场景 `monitor.ts:101 redis.get(sinceKey)` 每次 target 查询都经过这个共享连接。
- **修复**: 至少拆 3 个：bullmq-connection、pubsub-publisher、general-keyvalue。BullMQ 官方推荐这么做。工作量 **S**。

### P2

#### P2-1  `metrics-collector.ts` 接口定义但从未被调用
- **位置**: src/lib/metrics-collector.ts:12-30（grep 确认只有定义自己在用，metrics processor 内联了 X 逻辑）
- **问题**: 加一个新平台的 metrics 需要在 metrics.ts 里 copy-paste 而非实现接口，违反 CLAUDE.md "Adding a new platform = one entry"。
- **修复**: 把 metrics.ts 里的 `processXMetricsForUser` 抽成 `class XMetricsCollector implements MetricsCollector`，在 `getMetricsCollector` 注册。工作量 **M**。

#### P2-2  日志无结构化（string interpolation）、无 traceId
- **位置**: src/lib/logger.ts:29-44；全项目 `log.info('...')`
- **问题**: picocolors + console.log 只为本地开发好看。Railway/生产上没法 JSON parse，没法 trace 一个 discovery → content → review → posting 的链路（全都分散）。
- **修复**: 切换到 pino（pretty 只在 dev），每个 job 生成 `traceId = job.id`，通过 async_hooks `AsyncLocalStorage` 传进所有 `createLogger`。工作量 **M**。

#### P2-3  `processPosting` 的 0 retries 意图正确但错误分类粗糙
- **位置**: src/lib/queue/index.ts:88-95（`attempts: 1`）；src/workers/processors/posting.ts:170-177（失败仅更新 draft.status='failed'）
- **问题**: "永不重试" 防止重复发帖是对的，但连 Reddit API 网络抖动（ECONNRESET）都当作失败，用户要手动 retry。建议分类：pre-submit 错误（rate limit / circuit breaker / 鉴权失败 → 可 retry 且安全）vs post-submit 错误（post 已经发出但 response 读取失败 → 不可 retry）。
- **修复**: 在 `RedditClient.postComment`/`XClient.postTweet` 之后立即写 `posts` 表 (idempotency key = `draftId + userId`)，然后才做其它附加动作。若 DB 写失败也不 retry；若 submit 失败有明确区分。工作量 **M**。

#### P2-4  前端的 `__all__` 魔术字符串 + cron 数据重用业务类型
- **位置**: src/workers/index.ts:155-244（所有 scheduleXxx）；src/workers/processors/*.ts 到处 `if (userId === '__all__')`
- **问题**: 用 `userId: '__all__'` 表达 "这是一次 cron fan-out job" 混淆了数据模型。未来如果真的出现合法 userId === `__all__` 的 user.id 就炸。
- **修复**: Job data 改成 discriminated union：`{ kind: 'fanout' } | { kind: 'user', userId, productId }`，processor 里 `if (job.data.kind === 'fanout')`。工作量 **S**。

#### P2-5  `dev` script `concurrently` 启动 redis-server，worker/next 不等 redis ready
- **位置**: package.json:6
- **问题**: `concurrently --kill-others next dev  redis-server  bun --watch src/workers/index.ts`。worker 启动时 redis 还没 ready，ioredis 会重连，但 BullMQ scheduleXxx() 在启动阶段可能吞错；`worker/index.ts:256` 里 `Promise.all([scheduleXxx()]).catch(...)` 只 log 不中断。
- **修复**: 加 `wait-on tcp:6379` 或改用 `-s` flag；或者让 worker 启动时主动 ping redis 直到成功。工作量 **S**。

#### P2-6  单元测试基本为 0，核心业务逻辑裸奔
- **位置**: 仅 `e2e/tests/*.spec.ts`（5 个 Playwright），src 下没有任何 `*.test.ts`
- **问题**: scoring、`generate-queries` 平台映射（src/tools/generate-queries.ts:160-184）、`extractJson`、rate-limiter 窗口计算、circuit-breaker 24h 窗口都无单测。auth / OAuth callback 的 state 校验（包括 P0-4）无法通过 test 固化。
- **修复**: 至少给 `extractJson`、`RedditClient.rateLimitCheck`、`canPostToSubreddit` 加 Vitest unit test（项目已装 vitest devDep）。工作量 **M**。

---

## 3. 快赢（< 1 天）

1. **P0-2**: 给所有 `new Queue()` 加 `defaultJobOptions.removeOnComplete/removeOnFail`（5 分钟改 src/lib/queue/index.ts）。
2. **P0-3**: 给 `/api/scan` 加 `auth()` 或 Redis IP 限流（1 小时）。
3. **P0-4**: Reddit callback 加 state cookie 校验，copy X callback 模式即可（30 分钟）。
4. **P1-2**: discovery / content-calendar cron fan-out 改为 `enqueueXxx` 分发而非 worker 内串行（2 小时）。
5. **P1-5**: `/api/events` 的 heartbeat `clearInterval` 修漏（10 分钟）。
6. **P1-10**: 拆分 `getRedis` 为 bullmq/pubsub/kv 三个 connection（30 分钟）。
7. **P2-1**: 把 `processXMetricsForUser` 包成 `XMetricsCollector` class，清除 metrics-collector.ts 的 "未使用" 状态（2 小时）。
8. **P1-8**: agent-config 加载加 `Map` 缓存（15 分钟）。

---

## 4. 架构级建议（> 1 周）

### A. 把 "外部 IO 重试 + rate-limit + 缓存" 收敛成一层
reddit-client.ts / x-client.ts / api-client.ts 各自实现一套 retry + cache + rate-limit（mutex / bucket / per-endpoint），代码散、语义不一。建议抽象：

```
ExternalClient<T>.request(key, fn, { retry, cache, rateLimitBucket })
```

单处实现 exponential backoff + jitter、429/529 分类、token 刷新竞争（用 Redis SETNX 锁而非 per-instance mutex，多 worker 共享）。收益：可观测性、测试、可替换。

### B. Worker 拆分到独立 Railway service，按业务域分组
现在 14 个 worker 全在一个 bun 进程，lockDuration 统一 5min 除 calibration。一次 `calibration` 25 min 会撞到其它 worker 的 API 限流预算。建议：
- `worker-growth`（discovery/content/review/posting/monitor/content-calendar）
- `worker-analytics`（metrics/analytics/dream/health-score）
- `worker-scans`（code-scan + calibration 长任务）

隔离 Anthropic API 配额、Redis 连接、内存 footprint，故障不会互相传染。

### C. 彻底平台化
目前残存的硬编码：
- src/core/pipelines/full-scan.ts:100, 250（Reddit 特殊路径）
- src/workers/processors/discovery.ts:240（Reddit "r/" prefix）
- src/workers/processors/metrics.ts:69（externalId 正则启发式）
- src/workers/processors/monitor.ts, engagement.ts, metrics.ts, analytics.ts（文件名都叫 X-xxx，逻辑内 hardcode `platform: 'x'`）

这四个 X-专属 processor 应该通过 `createPlatformDeps` + platform-config 表驱动，和 discovery/content 对齐。

### D. 引入 OpenTelemetry trace + Anthropic cost attribution
现在 cost / token / turn 信息写在 `activityEvents.metadataJson`（查询成本高、无聚合）。
建议：trace context 从 API route → BullMQ job (`job.data._traceId`) → skill-runner → api-client.createMessage，对接 OTLP / Axiom / Datadog，直接看 "哪个 user 的 discovery 昨天跑了 $12"。

### E. 引入 outbox / transactional job enqueue
处理器里 `db.insert(drafts) … await enqueueReview(...)` 两步不原子，crash 之间会丢 job。用 pg-boss / drizzle-transaction-outbox 之类。

---

## 5. 需要前端 / 数据 agent 配合的点

1. **Queue 消息 schema 变更（P2-4）**: job data 加 `kind: 'fanout' | 'user'`。前端未用到，但数据链路 agent 需要同步更新消费端类型。
2. **`/api/drafts` / `/api/today` 减字段回显（P0-5）**: 拿掉 channel.oauthToken 等；前端已不用。确认一下 `src/app/(app)/settings/page.tsx` 也不依赖 encrypted token 字段。
3. **`posts.platform` 字段新增（P1-1）**: 数据链路需出 migration + backfill SQL（`UPDATE posts SET platform = (SELECT platform FROM threads WHERE ...)`）；前端 `/api/drafts` 顺势去掉 `threadPlatform` LEFT JOIN。
4. **`todoItems` expire 迁到 cron（P1-7）**: 前端需要容忍 "Today 列表里有已过期项"，用 `expiresAt > now` client-side 再过滤。或前端不用改但要知道 GET 响应可能短时间内含过期项。
5. **`/api/scan` 限流（P0-3）**: 前端需要处理 429 状态；考虑把 scan 改为 "登录后才能扫描" 或 "匿名 1 次/小时"，落地文案。
6. **成本字段 schema（P1-3）**: `activityEvents.metadataJson.cost` 单值改成 `{ total, byModel }`，前端展示面板需要兼容旧记录。
