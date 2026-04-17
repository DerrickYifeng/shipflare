# Data 视角体检报告

## 1. 数据链路全貌

```
┌───────────────────────────────────────────────────────────────────────┐
│  外部源                                                                 │
│  GitHub · Reddit OAuth · X v2 API · xAI Grok · Anthropic API          │
└───┬──────────────┬──────────────┬──────────────┬──────────────────────┘
    │              │              │              │
    ▼              ▼              ▼              ▼
 code-scan     discovery        monitor        metrics
 processor     processor        processor      processor
    │              │                │              │
    │  generate_   │  xClient       │              │
    │  queries →   │  .getUserTweets│              │
    │  reddit/x    │  sinceId→Redis │              │
    │  search →    │                │              │
    │  score_      │                │              │
    │  threads →   │                │              │
    │  judge       │                │              │
    ▼              ▼                ▼              ▼
┌─────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
│code_snapshots│ │threads   │ │x_monitored_  │ │x_tweet_      │
│ (1:1 product)│ │(+relevance│ │  tweets      │ │  metrics     │
│              │ │ Score)    │ │ + drafts     │ │ x_follower_  │
│              │ │+ drafts   │ │   (reply)    │ │  snapshots   │
└─────────────┘ └────┬─────┘ └──────┬───────┘ └──────┬───────┘
                     │              │                  │
                     ▼              ▼                  ▼
                 content         review            analytics
                 processor     processor          processor
                     │              │                  │
                     ▼              ▼                  ▼
                  drafts       drafts.review…    x_analytics_
                                                   summary
                     │
                     ▼
                 posting → posts → engagement → (drafts again)
                                                      │
                                                      ▼
                                                   todo_items →
                                                     前端 Today
                                                      │
                                      activity_events + dream (memory)
```

关键观察：`content` / `review` / `posting` / `engagement` 的数据接力完全靠 DB 外键
（`drafts.threadId`, `posts.draftId`），payload 里只传 ID，这是好事。但是 **`posts` 表
没有 `platform` 字段**，metrics 靠 `externalId` 正则 `^\d+$` 来猜 platform，脆弱。

## 2. Schema 健康度小结

| 表 | 用途 | 关键问题 | 建议 |
|---|---|---|---|
| `users` (users.ts:20) | Auth.js 用户 | OK | — |
| `accounts` (users.ts:32) | Auth.js GitHub token | **明文存储 access_token/refresh_token**；无 `userId` 索引（code-scan fan-out 每天全表扫描） | 加密 token；`index(userId)` |
| `channels` (channels.ts:12) | OAuth 凭证 + `post_history` JSONB | JSONB 数组无上限；`(userId, platform)` 无 unique 约束（同一个用户可插多条 X channel） | `unique(userId, platform)`；post_history 限长 50 条 |
| `threads` (channels.ts:37) | 所有平台发现的帖子 | 无 `(userId, externalId)` 唯一索引——发现端依赖应用层先 SELECT 再 INSERT（竞态） ；无 `(userId, discoveredAt)` 索引 | `unique(userId, platform, externalId)`；`index(userId, discoveredAt desc)` |
| `drafts` (drafts.ts:29) | 草稿 + review 结果 | 无 `(userId, status, createdAt)` 索引（前端列表查询场景）；`draftType` 是 text 不是 enum；`reviewJson` 结构无 schema | 加索引；`draftType` 改 pgEnum；把 `reviewJson` 结构锁定 |
| `posts` (drafts.ts:57) | 已发布记录 | **缺 `platform`**；缺 `(userId, postedAt desc)` 索引；`externalId` 无唯一约束（重复发布可产生两条 posts） | 加 platform 列 + backfill；`unique(platform, externalId)`；按 postedAt 索引 |
| `activityEvents` (drafts.ts:92) | 所有活动日志 | **无 TTL/归档策略**，会无限膨胀；`metadataJson` 任意结构 | 30 天后归档 + 按 `(userId, createdAt desc)` 索引 |
| `healthScores` (drafts.ts:74) | 时序快照 | 无 `(userId, calculatedAt desc)` 索引；保留策略缺失 | 加复合索引 |
| `agentMemories` (memories.ts:11) | 按 product 的知识 | 无 `productId` 索引 | `index(productId, type)` |
| `agentMemoryLogs` (memories.ts:37) | 日志流 → dream | 无 `(productId, distilled, loggedAt)` 索引；dream 每次全表扫 | 加部分索引 `WHERE distilled=false` |
| `codeSnapshots` (code-snapshots.ts:5) | **1:1** product（`.unique()`） | JSONB `fileTree`/`keyFiles` 无大小上限（大仓库可 MB 级别）；`commitSha` 无历史——无法做时序回查/A-B | 拆 `code_snapshot_history(productId, commitSha, diff, scannedAt)`；文件大小上限 |
| `xTargetAccounts` (x-growth.ts:20) | 被监控账号 | OK（有 unique） | — |
| `xMonitoredTweets` (x-growth.ts:47) | 抓回的推文 | `status` 是 text 不是 enum；无 `(userId, status, replyDeadline)` 索引（monitor 每次全表过滤 expired） | 加索引；text → enum |
| `xContentCalendar` (x-growth.ts:77) | 发布排期 | `status` text；无 `(userId, channel, status, scheduledAt)` 索引（content-calendar 每次全扫） | 复合索引 |
| `xTweetMetrics` (x-growth.ts:102) | 时序指标 | 有索引但不够：analytics 按 `(userId, sampledAt)` 过滤；**没有 `(tweetId)` 单列索引用于 dedup** | `index(userId, sampledAt desc)` |
| `xFollowerSnapshots` (x-growth.ts:128) | 每日粉丝快照 | 无 `(userId, snapshotAt)` 唯一——同一天跑两次 cron 会插两条 | `unique(userId, date(snapshotAt))` 或应用层 upsert |
| `xAnalyticsSummary` (x-growth.ts:145) | 汇总报告 | 只插不删；前端读最新那条需要 `ORDER BY computedAt DESC LIMIT 1` 全扫 | `index(userId, computedAt desc)` |
| `discoveryConfigs` (discovery-configs.ts:23) | 调参 | `previousConfig` 只存一版，无法多轮回滚；`calibrationLog` 是 jsonb 无结构约束 | 拆 `discovery_config_history` 表保留每一轮 |
| `todoItems` (todos.ts:37) | Today 页面 | 有 unique `(userId, draftId)`；缺 `(userId, status, expiresAt)` 索引 | 加复合索引 |
| `userPreferences` (users.ts:76) | 自动化偏好 | contentMix 四个字段和 ≠ 100 时无约束 | 加 CHECK 约束 |

**全局问题**：schema 里总共只有 **1 个 index 定义**（`x_tweet_metrics.ts:122`），其余表都
靠 PK/unique 顶着，所有按 userId/时间的查询是顺序扫描。这在 < 100 用户时没问题，超过
500 用户就是 P0 雪崩。

## 3. Top 问题清单

### P0-1 · 索引几乎为零
- **位置**：`src/lib/db/schema/*`（全 schema）
- **问题**：全项目仅 `x_tweet_metrics_user_tweet` 一条索引。`threads`、`drafts`、
  `posts`、`activity_events`、`x_monitored_tweets`、`x_content_calendar`、
  `x_tweet_metrics(sampledAt)`、`todo_items` 等热路径全部全表扫描。
- **影响**：前端 Today / Drafts 页列表、每小时 cron fan-out，用户数增长后 P95 立即崩。
- **修复**：按上表加 12 条复合索引。最少必须的：
  - `threads (user_id, discovered_at DESC)`、`unique(user_id, platform, external_id)`
  - `drafts (user_id, status, created_at DESC)`
  - `posts (user_id, posted_at DESC)`、`unique(platform, external_id)`
  - `activity_events (user_id, created_at DESC)`
  - `x_monitored_tweets (user_id, status, reply_deadline)`
  - `x_content_calendar (user_id, channel, status, scheduled_at)`
  - `x_tweet_metrics (user_id, sampled_at DESC)`
  - `todo_items (user_id, status, expires_at)`
- **工作量**：M（1 个 migration + 生产 `CREATE INDEX CONCURRENTLY`）

### P0-2 · posts 表缺 platform，metrics 靠正则猜
- **位置**：`src/lib/db/schema/drafts.ts:57-72`；`src/workers/processors/metrics.ts:69-71`
- **问题**：`xPosts = recentPosts.filter(p => /^\d+$/.test(p.externalId))` —— 用
  `externalId` 是不是纯数字来猜平台。Reddit 以后换成数字 ID、或 LinkedIn 接入都炸。
- **影响**：metrics 缺数据、analytics 汇总错误、多平台扩展阻塞。
- **修复**：`ALTER TABLE posts ADD COLUMN platform text NOT NULL DEFAULT 'reddit'`，
  backfill = `threads.platform`（通过 draft → thread 反查），改 metrics.ts 用
  `WHERE platform = 'x'`。
- **工作量**：S

### P0-3 · OAuth access_token 明文存在 accounts 表
- **位置**：`src/lib/db/schema/users.ts:41-42`（Auth.js `access_token` / `refresh_token`）
  vs `channels.oauthTokenEncrypted` 是加密的
- **问题**：GitHub OAuth token 明文写 DB；`code-scan.ts:82-89` 每天 fan-out 直接读。
  channels 表加密，accounts 表不加密——策略不一致。
- **影响**：DB 泄露 = 用户所有 GitHub 仓库授权泄露；合规风险。
- **修复**：在 Auth.js Drizzle adapter 外包一层加密；或把 GitHub token 从 accounts
  复制到独立加密表。
- **工作量**：M（Auth.js adapter hack 需小心）

### P0-4 · threads 插入存在竞态（非唯一约束）
- **位置**：`src/workers/processors/discovery.ts:164-192`、
  `src/workers/processors/monitor.ts:142-151`
- **问题**：先 SELECT 判重再 INSERT。并发 fan-out（比如同一用户两个平台 cron 撞上）
  会插重复 `threads` 行。`onConflictDoNothing` 只在 monitor/engagement 用了，discovery
  没用。
- **影响**：重复 draft → 重复回复 → 封号风险（尤其 X 的 Reply Guy 场景）。
- **修复**：加 `unique(user_id, platform, external_id)` + `.onConflictDoNothing()`。
- **工作量**：S

### P0-5 · Queue payload 契约漂移
- **位置**：`src/lib/queue/types.ts:1-108`；`EngagementJobData.contentText`
- **问题**：(a) 没有 version 字段——payload 字段一改，在途 job 全炸；(b)
  `EngagementJobData` 把 `contentText` 塞进 payload（tweet 全文），超长内容会进
  Redis stream 而不是 DB，和 "payload 传 ID，数据走 DB" 的原则不一致；(c)
  `XMonitorJobData` 等 backward-compat 别名一直没删。
- **影响**：部署期间在途 job 处理失败；Redis 内存膨胀；多人改同一类型时
  producer/consumer 漂移。
- **修复**：(1) 每个 Job 加 `schemaVersion: 1`；(2) `EngagementJobData` 只传
  `contentId`，文本在 processor 里按 ID 查 DB；(3) 给每个类型加 zod schema，
  `enqueue*` 函数先 `.parse()`。
- **工作量**：M

### P1-1 · 无漏斗埋点，metrics-collector 是空壳
- **位置**：`src/lib/metrics-collector.ts:22-30`（`getMetricsCollector('x')` 直接
  `return null`）；`activity_events` 只记模糊事件名
- **问题**：没有 funnel 能力回答"discovered → high-relevance → draft → approved →
  posted → engaged"每一步的转化率，以及每步的 P50/P95 时延。
- **影响**：产品侧无法回答"优化哪个环节 ROI 最大"。
- **修复**：(1) 新建 `pipeline_events(userId, threadId/draftId, stage, enteredAt,
  durationMs, cost)` 表；(2) 在 discovery / content / review / posting 每步 INSERT
  一行；(3) 后续前端 Dashboard 画漏斗。
- **工作量**：L（需要前端配合画图）

### P1-2 · Zod schema 与 DB schema 未对齐
- **位置**：`src/agents/schemas.ts:7-32` vs `src/lib/db/schema/channels.ts:37-60`
- **问题**：`discoveryOutputSchema.threads[].scores` 可选，`relevance` 和
  `relevanceScore` 两个字段混着用（discovery.ts:173-176 要除 100 或平均）。`drafts.
  reviewJson` 没有 zod 校验，LLM 返回脏数据直接落库。
- **影响**：脏数据入库；后续优化/eval 用历史数据时字段不一致。
- **修复**：统一字段名 `relevanceScore: 0-1`；给 `reviewJson` 写 zod schema 并在
  processor 里 parse。
- **工作量**：S

### P1-3 · code_snapshots 失去历史
- **位置**：`src/lib/db/schema/code-snapshots.ts:15`（`.unique()` on productId）+
  `src/workers/processors/code-scan.ts:218-244`（upsert 覆盖 fileTree）
- **问题**：每次扫描都 overwrite；`commitSha`/`diffSummary` 只留最新一个；无法回看
  "上周这个产品的代码长什么样"，无法做 A/B（功能上线 vs 不上线对 discovery 质量的影响）。
- **影响**：Discovery 优化闭环缺一半证据；code-based content-calendar 只能说"有变化"
  不能说"两周前已经聊过这个 feature"。
- **修复**：拆表 `code_snapshot_history(productId, commitSha, diffSummary,
  scannedAt)`，`codeSnapshots` 保持最新指针。
- **工作量**：M

### P1-4 · Discovery 优化闭环缺失真 label
- **位置**：`src/lib/discovery/judge.ts`（用 Haiku 自动判 true/false positive）+
  `src/lib/discovery/optimizer.ts`
- **问题**：precision 是 judge (Haiku) 自己打的分，没有人工 label 作为 ground truth；
  judge 和 scout 都是 LLM，容易同步偏差。没有"用户真回复了 → ground-truth potential
  user"这个信号喂回来。
- **影响**：优化器可能在错误的北极星指标上迭代，越调越偏。
- **修复**：(1) 增加 `thread_feedback(threadId, userAction: skip/approve/post)` 派生
  label；(2) judge 用这个校准，用 precision_judge + precision_human_proxy 两个指标。
- **工作量**：M（配合产品埋点）

### P1-5 · activityEvents / 历史表无归档
- **位置**：`src/lib/db/schema/drafts.ts:92-102`、所有时序表
- **问题**：`activity_events`、`x_tweet_metrics`（每小时写）、`x_follower_snapshots`
  无 TTL 策略，长期累积到百万行级就拖慢 analytics 的 `WHERE sampledAt >= 30d`。
- **影响**：12 个月后 DB 体积膨胀，analytics 计算延迟高。
- **修复**：(1) 30 天后 activity_events → S3/冷表；(2) `x_tweet_metrics` 保留一周
  原始 + 月度 rollup 表。
- **工作量**：M

### P1-6 · Monitor/Calendar processor N+1 查询
- **位置**：`src/workers/processors/monitor.ts:119-131`（循环内 SELECT 判重）、
  `src/workers/processors/discovery.ts:164-171`、
  `src/workers/processors/content-calendar.ts:165-171`
- **问题**：循环内每条 thread 发一个 SELECT；对于每次抓回 10 条推文 × N 个 target
  account 的用户，一次 monitor 就几十次 roundtrip。
- **影响**：worker 延迟高；DB connection pool 压力。
- **修复**：预先 `SELECT ... WHERE external_id IN (...)` 一次性批量判重；或直接
  INSERT + `onConflictDoNothing`。
- **工作量**：S

### P2-1 · channel.post_history 是无限增长的 JSONB
- **位置**：`src/lib/db/schema/channels.ts:25-33`
- **问题**：`post_history` 一直 append，单 row 可能 MB 级，影响整行读写。
- **修复**：限制前 50 条；或拆到独立表。
- **工作量**：S

### P2-2 · xFollowerSnapshots 每日重复
- **位置**：`src/workers/processors/metrics.ts:39-44`
- **问题**：metrics cron 每小时跑，但每小时都插入一条 follower 快照。实际是小时级数据
  但命名叫"daily snapshot"，analytics 用的时候按时间首尾抽两条算 growth rate 不够鲁棒。
- **修复**：改成每天一次（检查当天是否已有）或加 `unique(userId, date)`。
- **工作量**：S

### P2-3 · Migration 有命名冲突
- **位置**：`drizzle/0007_add_engagement_depth.sql` 和 `drizzle/0007_aspiring_kitty_
  pryde.sql`；`0008_add_user_preferences.sql` vs `0008_milky_lionheart.sql`；`0009_*`
  同名两次
- **问题**：同一编号两个 migration，生产回滚/新环境迁移有歧义。drizzle 会按文件名
  排序跑，但某些工具会跳。
- **修复**：手动合并 + 重新编号；或锁 journal。
- **工作量**：S

### P2-4 · Soft delete / 审计缺失
- **位置**：所有表
- **问题**：无 `deletedAt`；用户删一个 target account 数据直接 hard delete，所有
  monitored_tweets 级联删掉——历史回查失效。
- **修复**：核心表（products / channels / targets）加 `deletedAt`；processor 查询
  时 `WHERE deletedAt IS NULL`。
- **工作量**：M

### P2-5 · Drizzle config 未区分环境
- **位置**：`drizzle.config.ts`
- **问题**：只有一个配置，没区分 local/staging/prod；生产跑 `drizzle-kit push` 会
  直接改表。
- **修复**：生产只允许 `migrate`，禁 `push`；加 pre-deploy 检查。
- **工作量**：S

## 4. 快赢（< 1 天）

1. **加 6 条最痛的复合索引**：threads、drafts、posts、activity_events、
   x_monitored_tweets、x_content_calendar。CONCURRENTLY 建。(P0-1 子集)
2. **posts 加 platform 列并 backfill**，改 metrics.ts 的正则匹配。(P0-2)
3. **threads 加 `unique(user_id, platform, external_id)` + onConflictDoNothing**。(P0-4)
4. **Queue payload 加 `schemaVersion`**，给每个类型加 zod schema。(P0-5 第一步)
5. **`channel.post_history` 截断到 50 条**（写入时 slice）。(P2-1)
6. **`xFollowerSnapshots` 改每天一次** 或加 `unique(userId, date)`。(P2-2)
7. **删 BC 别名** `xMonitorQueue` / `XMonitorJobData` 等（确认无外部引用后）。
8. **monitor processor 批量判重**：一次 `SELECT external_id WHERE IN (...)`。(P1-6)

## 5. 需要 PM/Backend/Frontend 配合的点

- **漏斗埋点（P1-1）**：需要 PM 定义关键转化节点（建议：discovered → passed_gate
  → draft_created → approved → posted → got_engagement），Backend 加
  `pipeline_events` 表和埋点，Frontend 在 Dashboard 画漏斗图和 P50/P95 时延。
- **Discovery 真实 ground truth（P1-4）**：Frontend 需要记录用户对每条 draft 的
  action（approve/skip/edit），透传到 `thread_feedback`，optimizer 才能用人工信号
  校准 judge。
- **OAuth 加密迁移（P0-3）**：Backend 需协调 Auth.js adapter 侧改造，要么切换到
  自定义 adapter，要么加解密中间层；可能需要 PM 接受一次性 re-auth 风险或做 token
  双写切换窗口。
- **归档策略（P1-5）**：PM 确认历史数据保留期（合规 + 产品功能上多久的数据还要用）；
  Backend 做冷表 / S3 导出任务。
- **Schema 变更上线（P0-1/2/4）**：建议 Backend 走 `CREATE INDEX CONCURRENTLY` +
  先上灰度，避免长事务锁表；Frontend 在索引生效后把列表接口从 limit=20 放宽到
  limit=50（之前是因为慢才压着）。
- **Code snapshot 拆历史表（P1-3）**：Backend 改 code-scan processor；PM 决定
  保留粒度（每次 diff 保留 vs 每周保留一次）。
