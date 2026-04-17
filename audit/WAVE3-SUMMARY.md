# Wave 3 实施汇总

4 条 feature branch 已全部合入 main，worktree 已清理，分支已删除。

## Branch 1: `feat/today-end-to-end`（Theme 1 · Today 首屏 & 首跑体验端到端重做）

**4 commits**

- ✅ `perf(today)`: `GET /api/today` 去掉 write-on-read 副作用（原来每次 GET 先 `UPDATE todo_items SET status='expired'`），改用 `and(eq(status,'pending'), gt(expiresAt, now))` 过滤；timezone + `yesterdayStart`/`todayStart`/`yesterdayEnd` 从每请求算 4 遍收敛到 1 遍。
- ✅ `feat(db)`: 新增复合索引 `todo_items_user_status_expires` on `(user_id, status, expires_at)`，migration `drizzle/0012_today_index.sql` + `0012_snapshot.json` + journal entry。
- ✅ `feat(today)` hydration: `page.tsx` 服务端一次性查好 items + yesterdayTop + hasChannel，注入 `<SWRConfig fallback={{ '/api/today': fallbackData }}>`，消除"RSC 查数据→clientside 再 fetch→视觉跳变"三段式。`use-today.ts` 零改动（review-experience 分支负责）。
- ✅ `feat(today)` FirstRun: 原 120s 假进度条替换为 4 阶段 SSE 真实进度（`scout` → `discovery` → `content` → `review`），订阅 `/api/events` 的 `agent_start` / `agent_complete` / `draft_reviewed` 事件；SSE 不可用时降级时间模拟；超时文案按 `hasChannel` 分支。
- ✅ CompletionState 加 "Yesterday's top post" 卡片（community / title / upvotes / comments / 外链）+ Dashboard 点击入口。

**Merge commit**: `9dba3d2`（自动合并，无冲突）。

### 小发现
- schema 里其实已有一个 `todos_user_status_expires_idx`（列序相同），agent 另加了 `todo_items_user_status_expires`。两者共存不影响查询，后续可以考虑二选一删掉。
- `posts` 表没有 engagement metrics 列，Yesterday Top 目前显示的是 `threads` 上的 upvotes/comments（最近似的代理指标）。

## Branch 2: `feat/review-experience`（Theme 5 · 审核交互 + 轮询收敛一体化升级）

**5 commits**

- ✅ `refactor(today)`: `use-today.ts` 由 "filter → fetch → mutate()" 改成 `mutate(updater, { revalidate: false })` 的 merge-by-id 模式；失败回滚用 pre-click snapshot；`TodayActionError` 契约保留。Card 渲染 `aria-busy` + dim。
- ✅ `feat(today)`: 新 hook `useKeyboardShortcuts`（输入态自动跳过、modifier 抑制）+ `ShortcutsHelp` 覆盖层（`?` 触发）；Today/ReplyQueue/Drafts 页面全部绑定 `j` / `k` / `a` / `e` / `s` / `?`。active card 加 `ring-2` + `scrollIntoView`。
- ✅ `feat(content)`: `summaryReason` 字段加进 Content agent 输出 schema（`src/agents/schemas.ts` + 两个 reference 文档，≤120 字符）。可选字段，旧 draft 兜底显示 `whyItWorks` 的首句。
- ✅ `feat(drafts)`: `DraftCard` 加 `React.memo`；TodoCard / TweetCard / ContentCalendarRow / CalendarItemCard 早已 memo'd（Wave 1）。`byDay` / `pendingTweets` 已 memo 或不在 reply-queue 路径。`summaryReason` 默认展开，`whyItWorks` 折叠成 "See detailed reasoning"。
- ✅ `feat(drafts)`: Draft queue 4 个 source tab 重命名成用户语言："Scheduled replies / Scheduled posts / Engage with my audience / Community threads"；DraftCard 的 source badge 同步。
- ⚠️ SWRConfig wrapper 在 main 上已经有了（commit `448c557` Wave 1）—— 这一项自动识别并跳过。

**Merge commit**: `4dbdf05`（自动合并 `today-content.tsx`，无冲突）。

## Branch 3: `feat/sse-restructure`（Theme 7 · AgentStream / SSE 架构下沉）

**5 commits**

- ✅ `refactor(sse)`: `AgentStreamProvider` 从 `(app)/layout.tsx` 下沉到新建的 `(app)/automation/layout.tsx`，只有 `/automation/*` 付 EventSource + toast 的代价。
- ✅ `feat(sse)`: `/api/events` 支持 `?channel=agents|drafts|tweets|all`（默认 `all`）；未知值 fallback 到 all。原先的 heartbeat cleanup 其实已经正确（baseline `cancel()` 已清 interval/subscriber/maxAge）—— 只加 channel 过滤。
- ✅ `refactor(sse)`: 新 helper `publishUserEvent(userId, channel, data)` in `src/lib/redis/index.ts`，对 root + 每条 channel 双写；14 个 producer callsite 全部迁移（drafts → content/review；tweets → monitor/engagement；agents → discovery/posting/analytics/metrics/calibrate-discovery/content-calendar/automation-run）。
- ✅ `feat(sse)`: 新 hook `useSSEChannel` 封装 EventSource + onmount / onunmount 生命周期；`useDrafts` + `useMonitoredTweets` 把 15s/30s 轮询换成事件驱动 `mutate()`，保留 60s safety-net fallback。
- ✅ `feat(automation)`: War room Stop 按钮 + `POST /api/automation/stop` + `src/lib/automation-stop.ts`（`requestStop` / `isStopRequested` / `clearStop`）；discovery cron fan-out、discovery→content auto-enqueue、calibration 循环 3 处 poll-check；`/api/automation/run` 开始时 `clearStop`。
- ✅ `AgentStreamProvider` 新增 `errors[]`（cap 50）+ `dismissError` / `clearErrors`；war room Error Badge 可点击，打开右侧 `ErrorDrawer`（`<dialog>`，显示 traceId / timestamp / processor / 完整 payload）。

**Merge commit**: `6118593`（自动合并，无冲突）。

### 小发现
- `FirstRun` 没用 `useAgentStream`（它直接轮询 `/api/today`），relocation 对 Today 零影响。唯一真正的消费者是 `agents-war-room.tsx`。
- Stop 是 co-operative（两次迭代之间 / fan-out enqueue 之前），不能中断 agent 单轮 turn，符合 spec。

## Branch 4: `feat/pipeline-funnel`（Theme 6 · 数据漏斗 + 发布→数据闭环）

**7 commits + 1 rename commit**

- ✅ `feat(db)`: 新表 `pipeline_events` + `thread_feedback`（`src/lib/db/schema/pipeline-events.ts`）。stage 用 plain `text` + TS string-literal union（不用 pg enum，后续加 stage 不用 migration）。`pipeline_events.productId/threadId/draftId/postId` 都是 `SET NULL` on delete，telemetry 行不被业务 cascade 冲掉。索引：`(userId, stage, enteredAt DESC)` + `(userId, enteredAt DESC)`。
- ✅ `feat(lib)`: `recordPipelineEvent()` + `recordThreadFeedback()` helpers（`try/catch` 吞异常—— telemetry 不能把主流程拖挂）。
- ✅ `feat(workers)`: discovery（`discovered` + `gate_passed`）、content（`draft_created` + durationMs 与最近 thread event 对比）、review（`reviewed` + FAIL 时 `failed` + 自动 `approved`）、posting（`posted` + `post_failed`）、engagement（`engaged`）全部埋点；drafts approve / discovery approve 两条 route 同步插 `approved` + `thread_feedback.userAction='approve'`。
- ✅ `feat(metrics)`: `src/lib/collectors/x-metrics-collector.ts` implements `MetricsCollector`；`src/lib/collectors/index.ts` 注册到 platform registry；`metrics-collector.ts` 转发到 `getMetricsCollector(platform)` 而不是返回 null。
- ✅ `feat(dashboard)`: `/dashboard` 从"跳转到 today"替换成真的 Metrics 页：funnel bar chart（按 stage 占比）+ p50/p95 latency table（按 stage transition）；侧栏新增 "Metrics" 链接。
- ✅ `feat(calendar)`: `/api/calendar` JOIN posts + 最近 `x_tweet_metrics`；`status='posted'` 行渲染为 `<a target=_blank>` 并显示 likes/replies 内联图标。

**Merge commit**: `7636892`，手动解决 1 个冲突：

| 文件 | 冲突 | 处理 |
|---|---|---|
| `drizzle/meta/_journal.json` | idx=12 的 `when` 时间戳两边不同 | 保留 HEAD（today-end-to-end 的）时间戳；加入 idx=13 的 `0013_pipeline_funnel` entry |

**Migration 重命名**（merge 前预先在 worktree 里处理）：
- `0012_pipeline_funnel.sql` → `0013_pipeline_funnel.sql`
- `0012_snapshot.json` → `0013_snapshot.json`，`prevId` 从 0011 的 uuid 指到 0012（today-end-to-end）的 uuid；同时补齐 `todo_items_user_status_expires` 索引（因为 0013 = 0012 + pipeline tables）
- `_journal.json` 从 idx=12 改 idx=13，保留 idx=12 的 0012_today_index entry 占位（merge 时和 HEAD 冲突，手工取了 HEAD 的 `when` 值）

### 小发现
- `workers/processors/metrics.ts` 里的 X-metrics 抓取还是走原先的 inline 路径，没被切换到新的 registry（留到下一轮 refactor）。
- `dashboard-content.tsx` 变成了 orphan（`/dashboard/page.tsx` 完全重写），没删留在 repo 里保守点。
- `thread_feedback` 用 `onConflictDoUpdate (userId, threadId)` 做 upsert，让 `post` 动作可以覆盖 `approve` 动作。

## Wave 3 总影响

**61 files · +8904 / -293**（相对 Wave 2 合并完成点 `16505da`）

**TypeScript 状态**：
- `tsc --noEmit` exit 0（零类型错误）

**ESLint 对比**（跑在 `src/`）：
- Post-Wave-2: 62 problems (48 errors, 14 warnings)
- Post-Wave-3: **61 problems (47 errors, 14 warnings)**
- Wave 3 没引入新 error，还清掉了 1 个（累计 Wave 1+2+3 从 pre-Wave-1 的 79 缩到 61）。

**Worktree 清理**：
- 4 个 worktree 全部 `worktree remove --force` 并 `prune`
- 4 个 branch 全部 `branch -D`
- 主 worktree `/sessions/bold-stoic-johnson/mnt/shipflare` 在 main，clean

## Migration 现状

```
drizzle/
  0010_posting_flow_optimization.sql   # 未在 journal，main WIP 手写
  0011_simple_excalibur.sql            # idx=11, from Wave 1 schema-index
  0012_today_index.sql                 # idx=12, Wave 3 today-end-to-end
  0013_pipeline_funnel.sql             # idx=13, Wave 3 pipeline-funnel
```

Snapshot chain：`0011 (f0307283) → 0012 (a4b1ef22) → 0013 (a7e29c40)`。

0007/0008/0009 历史编号冲突**仍未处理**，部署前需要人工对齐生产 migration 状态（3 个 wave 一致遗留）。

## 下一步

- Wave 3 全部完成，所有 audit 主题中"强烈推荐首批"和"首批之后的主题 5/6/7"都已落地。
- 未动的审计主题：主题 4 的 P0-5（`channels.oauth_token_encrypted` 白名单）和 P0 GitHub token 加密；主题 8 的部分收口（metrics.ts 没迁到 registry）；主题 9 已在 Wave 2 合入；主题 10 已在 Wave 2 合入。
- 推远端：`git push origin main` —— 目前 ahead of origin 累计 Wave 1+2+3 的 ~50 commits（包含 4 个 feature merge commit + 25 个 feature commit）。
- 建议部署前走一次 Playwright e2e（wave 3 改动了 /today、/drafts、/dashboard、/automation 4 个页面）。
