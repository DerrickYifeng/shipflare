# ShipFlare 体检合并报告（跨角色交叉分析）

> 本报告合并 PM / Backend / Frontend / Data 四份独立审计，识别"多个 agent 从各自角度指向同一根因"的主题。这些跨角色共振点是 ROI 最高的切入点——一次投入，四个维度同时改善。
>
> 下面 10 个主题按推荐实施顺序排列。每个主题给出：参与角色、核心诊断、统一修复方案、工作量、阻塞/被阻塞关系。

---

## 主题 1 · Today 首屏 & 首跑体验端到端重做【强烈推荐首批】

**共振点**：4 个 agent 全部命中

| 角色 | 诊断 | 引用 |
|---|---|---|
| PM | FirstRun 120s 纯时间假进度条，失败无归因；`CompletionState` 没点击入口 | `first-run.tsx:21-68`、`completion-state.tsx:30-40` |
| FE | Today 页 RSC 已查 DB 但数据不传，client 再 fetch，三次视觉跳变；`FirstRun` 用轮询而非 SSE | `today/page.tsx:1-43` + `today-content.tsx:1-54`、`first-run.tsx:15-66` |
| BE | `/api/today` 每次 GET 先 UPDATE expired 全表扫写，再 4-way JOIN；timezone 计算每请求算 4 遍 | `api/today/route.ts:19-29, 32-79, 94-117` |
| Data | `todo_items` 无 `(userId, status, expiresAt)` 复合索引 | `todos.ts:37` |

**合并方案**（一气呵成）：
1. **后端**：把 todo expire 移到 cron（每 5min）或 DB trigger；`/api/today` 用 `WHERE expiresAt > now`，去掉 UPDATE 副作用。
2. **数据**：加 `todo_items(user_id, status, expires_at)` 复合索引；timezone 结果缓存进 userPreferences。
3. **前端**：`today/page.tsx` 把 server 查到的 items 作为 `fallbackData` 传给 `TodayContent`；`FirstRun` 订阅 SSE `agent_complete` 事件，进度条按 scout→discovery→content→review 四段真实推进；超时后根据账号连接状态分支（P0-3 的一部分）。
4. **PM**：`CompletionState` 加"Yesterday's top post"卡片 + metrics 小型展示（打通发布→数据闭环 P1-6）。

**工作量**：L（后端 S + 数据 S + 前端 M + PM 决策 S）
**用户感知**：首屏无抖动、首跑可见真实进度、失败能看到下一步——直接提升留存。
**被阻塞**：无。可以首批做。

---

## 主题 2 · 索引 + unique 约束 + posts.platform 一次性加固【强烈推荐首批】

**共振点**：Data + Backend

| 角色 | 诊断 |
|---|---|
| Data P0-1 | 整个 schema 只有 **1 条** index 定义（`x_tweet_metrics_user_tweet`），其余全靠 PK |
| Data P0-2 | `posts` 无 `platform` 列，metrics 靠 `/^\d+$/.test(externalId)` 猜平台（`metrics.ts:69-71`） |
| Data P0-4 + BE P0-1 | `threads` 无 `(userId, platform, externalId)` unique，discovery 处理器 N+1 先 SELECT 再 INSERT 有竞态（`discovery.ts:164-192`） |
| BE P1-1 | 同一根因 —— metrics 靠 regex 判平台 |
| BE P1-2 + Data P1-6 | monitor/content-calendar 循环内 SELECT 判重（N+1） |

**合并方案**（一个 migration + 几个批量改动）：
1. 一份 migration 批量加 8 条复合索引：`threads(userId, discoveredAt DESC)` + `unique(userId, platform, externalId)`、`drafts(userId, status, createdAt DESC)`、`posts(userId, postedAt DESC)` + `unique(platform, externalId)`、`activity_events(userId, createdAt DESC)`、`x_monitored_tweets(userId, status, replyDeadline)`、`x_content_calendar(userId, channel, status, scheduledAt)`、`x_tweet_metrics(userId, sampledAt DESC)`、`todo_items(userId, status, expiresAt)`。生产用 `CREATE INDEX CONCURRENTLY`。
2. `posts` 加 `platform text NOT NULL DEFAULT 'reddit'` 列 + backfill from `threads.platform`；改 `metrics.ts` 用 `WHERE platform='x'`。
3. `threads` 加 unique → discovery/monitor/content-calendar 全部改成 `onConflictDoNothing()` 单条批量 insert。
4. monitor/content-calendar 循环内 `SELECT external_id IN (...)` 一次性批量判重。

**工作量**：M（一个 migration + 3 个 processor 改写）
**用户感知**：列表查询从"能跑"到"快"；并发竞态消失。
**被阻塞**：无。和主题 1 可并行做。

---

## 主题 3 · Queue / Worker 基础设施加固【强烈推荐首批】

**共振点**：Backend 主导 + Data 补位

| 角色 | 诊断 |
|---|---|
| BE P0-2 | 所有 `new Queue()` 都缺 `defaultJobOptions.removeOnComplete/removeOnFail` —— Redis 内存线性膨胀 |
| BE P0-6 + BE P1-2 | cron fan-out 在 worker 内串行 for-loop，用户间互相阻塞 |
| BE P1-5 | `/api/events` SSE heartbeat `setInterval` 不清理，连接泄漏 |
| BE P1-10 | ioredis 单 connection 被 BullMQ、pubsub、keyvalue 三方共享 |
| BE P1-8 | skill-runner 每次 `runSkill` 重新 parse .md + rebuild tool registry |
| Data P0-5 | Queue payload 无 `schemaVersion`；`EngagementJobData.contentText` 违反"payload 传 ID" |
| BE P2-4 | `userId === '__all__'` 魔术字符串表达 cron fan-out |

**合并方案**：
1. `src/lib/queue/index.ts` 所有 Queue 加 `defaultJobOptions: { removeOnComplete: { count: 500, age: 24*3600 }, removeOnFail: { count: 2000, age: 7*24*3600 } }`。
2. `getRedis()` 拆 3 个连接：`bullmq-connection` / `pubsub-publisher` / `general-keyvalue`。
3. cron processors（discovery/content-calendar）改为 fan-out 模式——cron job 只做 `for each user: await enqueueXxx({ userId, productId })`，然后由正常 worker 按 concurrency 并行。
4. Queue job data 改成 discriminated union `{ kind: 'fanout' } | { kind: 'user', userId, productId }` + 每条加 `schemaVersion: 1`；`EngagementJobData` 只传 `contentId`。
5. `/api/events` route 的 `cancel()` 里 `clearInterval(heartbeat)`。
6. skill-loader 加 `Map<string, AgentConfig>` 缓存（modtime-aware）。

**工作量**：M（全是定点修改，测试覆盖要做）
**用户感知**：长期稳定性（不会突然所有自动化都停）；cron 从串行改并行会让"监控到新推特"的反应速度从分钟级回到秒级。
**被阻塞**：无。

---

## 主题 4 · 安全收口【强烈推荐首批】

**共振点**：Backend + Data

| 角色 | 诊断 |
|---|---|
| BE P0-3 | `/api/scan` SSE 完全未鉴权，匿名可刷 $0.20+/次 Anthropic 调用 |
| BE P0-4 | Reddit OAuth callback 不校验 `state`（CSRF 账户劫持）——X 的 callback 做对了，Reddit 漏 |
| BE P0-5 | `channels.oauthTokenEncrypted` 在多处 `select().from(channels)` 被回显到 app 层 |
| Data P0-3 | Auth.js `accounts.access_token` / `refresh_token` 明文存储（与 channels 加密策略不一致） |
| BE P2-5 | `dev` script 不等 redis ready |

**合并方案**：
1. `/api/scan` 加 `auth()` 或 Redis IP 限流（未登录 1次/小时，登录用户并发 ≤1）。
2. Reddit `connect/route.ts` 写 `httpOnly` cookie `reddit_oauth_state=${state}`，`callback/route.ts` 比对删除 —— 抄 X 的写法。
3. 所有 API route 改成 `select({ id, userId, platform, username, ... })` 显式白名单，剔除 oauthTokenEncrypted。
4. GitHub token 加密：包装 Auth.js Drizzle adapter 做 encrypt/decrypt；或独立加密表双写后切换。

**工作量**：M（1、2、3 是 S，4 是 M）
**用户感知**：无感（安全本应如此）；但不修是真实的法律 / 成本 / 账户被接管风险。
**被阻塞**：无。必须现在修 —— 时间越长爆炸半径越大。

---

## 主题 5 · 审核交互 + 轮询收敛一体化升级

**共振点**：PM + Frontend 强耦合

| 角色 | 诊断 |
|---|---|
| PM P1-1 | 审核无键盘快捷键、无批量；每天 30+ 次点击 |
| PM P1-2 | "Why this works" 折叠太深；用户要么不敢按要么机械按 |
| PM P1-3 | `source` 维度（Monitor/Calendar/Engagement/Discovery）是黑话 |
| FE P0-3 | 10 个 `refreshInterval` 叠加 + 默认 `revalidateOnFocus` → 切 tab 回来一排请求，approve 后列表"闪一下" |
| FE P0-4 | 乐观更新后紧跟 `mutate()` 抖动 |
| FE P1-8 | Reply Queue / Target Accounts / Calendar 未 memo；列表按日 group 每次重建 |

**合并方案**：
1. `(app)/layout.tsx` 加 `<SWRConfig value={{ dedupingInterval: 5000, focusThrottleInterval: 10000, revalidateOnFocus: false }}>`。
2. Today/Reply Queue 加全局 `useKeyboardShortcuts`：`j/k/a/e/s/?`。
3. 用 React 19 `useOptimistic` + `mutate(updater, { revalidate: false })` 替换"filter 掉 → fetch → mutate()"模式。
4. 按 id merge 而不是 filter，消除抖动。
5. `byDay` / `pendingTweets` 用 `useMemo`；`TweetCard` / `CalendarItemCard` / `TodoCard` 加 `React.memo`。
6. Draft card 加 `summaryReason` 字段（1 句话，默认展开），`whyItWorks` 保持折叠；Content agent schema 补这个字段。
7. Draft queue 四个 source tab 改文案：Scheduled posts / Replies to targets / Engage with my audience / Community threads。

**工作量**：M~L（多个 hook 改写 + 组件 memo + content agent schema 微调）
**用户感知**：Today 从"抖"变"顺"；审核速度翻倍；用户对 AI draft 信任度提升。
**被阻塞**：无。但和主题 1 有协同（都要改 Today 体验），可以合并一次性做。

---

## 主题 6 · 数据漏斗 + 发布→数据闭环

**共振点**：PM + Backend + Data + Frontend 全员，但都是 L 级投入

| 角色 | 诊断 |
|---|---|
| PM P1-6 | 发布→数据闭环缺失，用户拿不到正反馈 |
| Data P1-1 | `metrics-collector.ts:22-30` 是空壳（`return null`），无漏斗埋点能力 |
| BE P2-1 | `metrics-collector.ts` 定义了接口但从未被调用，违反"新平台 = 一个入口"原则 |
| Data P1-4 | Discovery 优化闭环 ground truth 缺失——judge 是 LLM 自说自话，没用户 approve/post 的真实反馈 |

**合并方案**：
1. 新建 `pipeline_events(userId, threadId/draftId, stage, enteredAt, durationMs, cost)` 表——记录 discovered → passed_gate → draft_created → approved → posted → engaged 全链路事件。
2. Backend 在 discovery/content/review/posting 每一步 INSERT 一行。
3. Frontend 新 Dashboard 画漏斗 + P50/P95 时延图；`CompletionState` 加"Yesterday's top post" + metrics 小卡；Calendar item `status=posted` 点开显示该帖子表现。
4. 抽 `XMetricsCollector implements MetricsCollector`，激活 metrics-collector.ts 的接口契约（CLAUDE.md 里说的"Adding a new platform = one entry"）。
5. Discovery 优化闭环加 `thread_feedback(threadId, userAction: skip/approve/post)` 派生 label，judge 用 precision_judge + precision_human_proxy 两指标校准。

**工作量**：L（新表 + 全链路埋点 + 前端图表 + 优化器改造）
**用户感知**：用户第一次能回答"ShipFlare 帮我做成了多少事"；产品侧能回答"优化哪个环节 ROI 最大"。
**阻塞关系**：依赖主题 2（索引），被主题 10（日志/trace）放大价值。

---

## 主题 7 · AgentStream / SSE 架构下沉

**共振点**：Frontend + Backend

| 角色 | 诊断 |
|---|---|
| FE P0-2 | `AgentStreamProvider` 挂在 `(app)/layout.tsx`，但只有 `/automation` 用；其他 5 页白占 EventSource + 随机弹 toast |
| BE P1-5 | heartbeat 泄漏（同主题 3） |
| PM P1-4 | war room 看得见但看不懂、停不下——SSE 信息粒度与 UI 不匹配 |

**合并方案**：
1. `AgentStreamProvider` 下沉到 `/automation/layout.tsx`。
2. 如果 `FirstRun`/`ThoughtStream` 需要 agent 事件，也独立订阅（或走主题 1 的改造——`FirstRun` 用 SSE）。
3. 后端 `/api/events` 支持 `?channel=tweets|drafts|agents` 细分，让 reply-queue / drafts 用 SSE push 替代 15s 轮询。
4. war room 加 Stop/Cancel 按钮，Error Badge 可点击打开详情抽屉（PM P1-4）。

**工作量**：M
**用户感知**：跨页不再被 toast 打扰；Reply Queue 更新秒级到达；war room 可干预。
**被阻塞**：建议在主题 3 之后（queue 健康先搞好，再改 SSE 消费模式）。

---

## 主题 8 · 平台抽象彻底收口

**共振点**：Backend + Data（CLAUDE.md 的核心架构原则）

| 角色 | 诊断 |
|---|---|
| BE P0-7 | `src/core/pipelines/full-scan.ts:100, 250` 硬编码 `platform === 'reddit'` |
| BE 架构建议 C | monitor/metrics/engagement/analytics 四个 processor 文件名和逻辑都 X-专属，未走 platform-config |
| Data P0-2 | posts 缺 platform（主题 2 已处理） |
| BE P2-1 | metrics-collector 接口空壳（主题 6 已处理） |

**合并方案**：
1. 引入 `createPublicPlatformDeps(platforms: string[])` 或让 `full-scan` 遍历 `Object.keys(PLATFORMS) + isPlatformAvailable`。合并阶段的 per-platform intel 校验放进 `platform-config.ts` hook。
2. monitor/metrics/engagement/analytics 里硬编码 `platform: 'x'` 改成从 `createPlatformDeps()` 路由；或至少统一走同一套接口，后续新增 LinkedIn/Mastodon 只加一个 config entry + 一个 collector。

**工作量**：L（但不紧急——除非立即要加新平台）
**用户感知**：无（纯架构）。
**价值**：未来加新平台的成本从"一周"压到"一天"。

---

## 主题 9 · 错误处理统一 + 发布归因修复

**共振点**：PM + Frontend

| 角色 | 诊断 |
|---|---|
| PM P0-3 | `discovery/approve/route.ts:64-81` 没 channel 时 log.warn 然后返回 success → 用户以为发成功了 |
| FE P1-9 | `alert()` / `confirm()` / `window.location.reload()` 三处混用；无 `error.tsx` / `ErrorBoundary` |
| PM P2-4 | 连接账号 / 取消连接的错误处理降级到 `alert()` |

**合并方案**：
1. `discovery/approve/route.ts` 按 `thread.platform` 匹配 channel，缺失时返回 `{code: 'NO_CHANNEL_X'}`，前端 toast 带 "Go to Settings" action。
2. 所有 `alert()` / `confirm()` / `window.location.reload()` 替换成 Toast + Dialog；`settings/connections-section.tsx:24-29`、`product/*-section.tsx`。
3. 每个 `(app)/` 路由段加 `error.tsx`，根加 `global-error.tsx`。
4. Settings Connections 连接状态支持 Connected / Expired / Not connected 三态。

**工作量**：M
**用户感知**：错误可见、可操作；不会发生"以为发出去其实没发"这种信任崩坏事件。

---

## 主题 10 · 观测基础设施：日志 / trace / cost

**共振点**：Backend + Data

| 角色 | 诊断 |
|---|---|
| BE P1-3 | `UsageTracker._model` 只保留最后一次，跨模型计费系统性偏差 |
| BE P2-2 | 日志无结构化、无 traceId |
| Data P1-5 | `activityEvents` 无 TTL，长期膨胀 |

**合并方案**：
1. 切换到 pino 结构化日志，每个 job 生成 `traceId = job.id`，通过 `AsyncLocalStorage` 传给所有 `createLogger`。
2. `UsageTracker` 改为 per-model buckets：`{ costUsd, byModel: { model: tokens+cost } }`。
3. 引入 OpenTelemetry trace 或最简版：traceId 从 API route → BullMQ job → skill-runner → api-client 全链透传。
4. `activity_events` 30 天后归档冷表；`x_tweet_metrics` 保留一周原始 + 月度 rollup。

**工作量**：M~L
**用户感知**：无（内部）。
**价值**：主题 6 的漏斗才真实可信；成本告警才能用。

---

## 快赢清单（<1 天就能完成，可以先摘桃子）

从 4 份报告汇总后去重：

| # | 改动 | 来源 | 位置 |
|---|---|---|---|
| 1 | 全局 `<SWRConfig>` 关掉 focus revalidate | FE | `(app)/layout.tsx` |
| 2 | 所有 `new Queue()` 加 `removeOnComplete/removeOnFail` | BE | `src/lib/queue/index.ts` |
| 3 | `/api/scan` 加 `auth()` | BE | `api/scan/route.ts:13` |
| 4 | Reddit callback 加 state cookie 校验 | BE | `api/reddit/callback/route.ts` |
| 5 | SSE heartbeat `clearInterval` 修漏 | BE | `api/events/route.ts:49-52` |
| 6 | `getRedis()` 拆 3 个连接 | BE | `src/lib/redis/index.ts` |
| 7 | skill-loader 加 Map 缓存 | BE | `src/core/skill-loader.ts` |
| 8 | Today 键盘快捷键 `a/s/e/j/k` | PM+FE | `todo-list.tsx` + 新 hook |
| 9 | 连接账号 `alert()` → Toast | PM+FE | `connections-section.tsx:24-29` |
| 10 | Growth 只有 X 时隐藏二级 tab | PM+FE | `growth/layout.tsx:17-38` |
| 11 | Calendar 删除加 5s undo | PM+FE | `unified-calendar.tsx:280-288` |
| 12 | Posting hours 按本地时间显示 | PM+FE | `automation-section.tsx:179-190` |
| 13 | `posts` 加 platform 列 + backfill | Data | migration |
| 14 | `threads` 加 unique + onConflictDoNothing | Data+BE | migration + `discovery.ts` |
| 15 | Queue payload 加 `schemaVersion` | Data | `queue/types.ts` |
| 16 | `channel.post_history` 截断 50 条 | Data | `channels.ts` 写入侧 |
| 17 | monitor/calendar 批量判重 `IN (...)` | Data+BE | 3 个 processor |
| 18 | Metadata title template | FE | `app/layout.tsx` |
| 19 | Landing input 加 `aria-label` | FE | `landing-page.tsx:164` |
| 20 | 按钮 disabled 加 `title` 提示 | FE | `automation-section.tsx:264` 等 |

---

## 实施路径建议（如果你要按顺序推）

**Wave 1 — 立即做（1~2 周）**
- 主题 4 · 安全收口（P0 合规）
- 主题 3 · Queue / Worker 基础设施
- 主题 2 · 索引 + unique + posts.platform
- 快赢清单 1~20（穿插着做）

**Wave 2 — 紧随其后（2~3 周）**
- 主题 1 · Today 端到端
- 主题 5 · 审核交互 + 轮询收敛
- 主题 9 · 错误处理统一

**Wave 3 — 平台化 & 可观测（3~4 周）**
- 主题 6 · 数据漏斗（需要 PM 定义节点）
- 主题 7 · AgentStream 下沉
- 主题 10 · 日志 / trace / cost
- 主题 8 · 平台抽象收口（可持续做）

---

## 跨角色 checklist（实施阶段要注意的传导）

- `posts.platform` 新增 → 前端 `/api/drafts` 去掉 `threadPlatform` LEFT JOIN
- `todoItems` expire 迁 cron → 前端 Today 容忍"列表里短时间有已过期项"
- `/api/scan` 限流 → 前端 handle 429
- Queue schemaVersion → consumer 要加版本兜底（新旧共存过渡期）
- `channels` select 白名单 → 前端验证仍能拿到 username / platform
- 新 `pipeline_events` 表 → PM 定义节点 + 前端画漏斗图
- SSE 频道细分 → 前端替换 15s 轮询
