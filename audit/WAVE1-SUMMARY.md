# Wave 1 实施汇总

4 条 feature branch 已经就位，每条都在独立 worktree 里做完 commit。main 分支的未提交改动**未被触碰**。

## 如何查看每条分支

你的未提交改动在 main 上，**不要直接 checkout**。用 worktree 查看最方便：

```bash
# 进入某个 worktree 查看/测试
cd /Users/yifeng/Documents/Code/shipflare/.worktrees/security
git log --oneline
git diff main

# 或者直接 diff 不进入 worktree
cd /Users/yifeng/Documents/Code/shipflare
git diff main..feat/security-hardening
git log main..feat/security-hardening --oneline
```

合并前建议 review 顺序：**security → queue-infra → schema-index → frontend-polish**（按风险从高到低）。

---

## Branch 1: `feat/security-hardening`

**1 commit · 16 files · +221/-30**

- ✅ `/api/scan` 加 `auth()` + Redis INCR+EXPIRE 限流（登录 1/60s，匿名 1/IP/hour）；429 带 `Retry-After` header
- ✅ Reddit OAuth callback 抄 X 的 state CSRF 校验（httpOnly cookie `reddit_oauth_state`）
- ✅ 所有 `select().from(channels)` 白名单改造，16 处调用收口；`oauthTokenEncrypted` 只在 `src/lib/platform-deps.ts` 这一个入口读
- ⚠️ GitHub token 加密 **deferred** — Auth.js Drizzle adapter 无 field-level encryption hook，需独立 PR 做 adapter 包装；已在 CLAUDE.md 加「Security TODO」条目 + schema 注释

**Commit**: `5b00856`

---

## Branch 2: `feat/queue-infrastructure`

**6 commits · 17 files · +763/-231**

- ✅ 所有 Queue 加 `removeOnComplete: {500, 24h}` / `removeOnFail: {2000, 7d}` + `attempts:3` exponential backoff（posting 仍 `attempts:1`）
- ✅ `/api/events` SSE heartbeat `clearInterval` 修漏 + 30min maxAge 强制重连
- ✅ `getRedis()` 拆成 `getBullMQConnection` / `getPubSubPublisher` / `getKeyValueClient`；保留 `getRedis()` 作为 deprecated alias
- ✅ cron fan-out（discovery / content-calendar / monitor / metrics / analytics）从串行 for-loop 改 `await enqueueXxx()` 真并行
- ✅ Queue payload：zod schema + `schemaVersion: 1` + discriminated union `{kind:'fanout'|'user'}`；`isFanoutJob()` 兼容旧 `userId==='__all__'`；`EngagementJobData.contentText` 改成传 `draftId`，processor DB 查文
- ✅ skill-loader / load-agent 加 `Map` 缓存（`DISABLE_SKILL_CACHE=1` bypass）

**⚠️ 兼容性注意**：cron 重复 job 下次 tick 会自然用新 payload；在途 engagement job 60min 后落地时会走 legacy fallback 分支。**约 1 周后可 follow-up 清理 `__all__` 和 `contentText` 兼容代码**。

**Commits**: `542dfbe af26dff df982da d03d43d 3b673a3 b68f3af`

---

## Branch 3: `feat/schema-index-overhaul`

**5 commits · 14 files · +3402/-295**（大部分是 drizzle 自动生成的 `0010_snapshot.json`）

- ✅ 15 条复合索引 / unique 约束加完（threads / drafts / posts / activity_events / health_scores / x_* / todo_items / agent_memories / accounts / channels）
- ✅ `posts.platform` 列新增，`posting.ts` 写入时带；`metrics.ts:69-71` 的 `/^\d+$/.test()` 换成 `eq(posts.platform, 'x')`
- ✅ `discovery.ts` N+1 消除 — 一次 bulk insert + `onConflictDoNothing({ target: [userId, platform, externalId] }).returning()`；顺便把 `r/` 硬编码换成 `getPlatformConfig(platform).sourcePrefix`
- ✅ monitor / content-calendar 批量判重（`IN (...)` 一次查 + bulk insert）
- ✅ `xFollowerSnapshots` 加 `snapshot_date` 列 + unique，metrics.ts 写入用 `onConflictDoNothing`
- ⚪ `channel.post_history` 截断 — **skip**，grep 无匹配，疑已被移除
- ✅ Migration `drizzle/0010_simple_excalibur.sql` 已生成并**手动校对**：
  - `posts.platform` 走 3 步（add nullable → backfill join → SET NOT NULL）
  - 所有 `CREATE INDEX` 改 `IF NOT EXISTS`
  - `x_follower_snapshots.snapshot_date` 同样 3 步 + 预 `DELETE ... USING` 清除已有同日重复
  - `discovery_configs` 包 `DO $$ EXCEPTION WHEN duplicate_object` 兼容 0009 孤儿 migration

**⚠️ 部署风险** —— 必须人工 pre-flight：
1. `threads` / `posts` 如果生产已有脏数据（同 (userId,platform,externalId) 或 (platform,externalId) 多条），unique index 创建会失败。部署前跑 `SELECT ... HAVING COUNT(*)>1` 检查。
2. drizzle 不能在 transaction 里发 `CREATE INDEX CONCURRENTLY`。**建议部署流程**：停 worker → 手工 `\i` 跑或改成 concurrent → 重启 worker。或容忍短暂 ACCESS SHARE 锁。

**🚨 历史 migration 编号冲突（未修复，由你手动处理）**：
- `0007_add_engagement_depth.sql` vs `0007_aspiring_kitty_pryde.sql`
- `0008_add_user_preferences.sql` vs `0008_milky_lionheart.sql`
- `0009_add_analytics_summary.sql` vs `0009_add_discovery_configs.sql`

只有 `*_kitty_pryde` / `*_lionheart` / `_add_discovery_configs` 三个在 `_journal.json` 里；另外三个疑似孤儿手写 migration。**在跑 0010 之前**需要确认生产实际跑过哪一支。

**Commits**: `74f6b2a 0bff402 d7e8f26 e47371b 30f00be`

---

## Branch 4: `feat/frontend-polish-wave1`

**4 commits · 19 files · +440/-156**

- ✅ QW#1 全局 `<SWRConfig>` 关掉 `revalidateOnFocus`（`dedupingInterval=5s`, `focusThrottleInterval=10s`）
- ✅ QW#6 `useMemo(byDay, [items])` 三处 + `React.memo` 四个 card（TodoCard / CalendarItemCard / ContentCalendarRow / TweetCard）
- ✅ QW#2 `connections-section.tsx` `alert()` → `useToast()`；`reload()` → `router.refresh()`（TODO：`/api/channels` endpoint 出现后换 SWR mutate）
- ✅ QW#3 Growth 页单平台自动隐藏二级 tab
- ✅ QW#4 Calendar 删除 5s undo —— 扩了 `toastWithAction({ action, timeoutMs, onTimeout })`；`unified-calendar.tsx` 软删 + 计时后才真调 API
- ✅ QW#5 Posting hours 按钮显示本地时间（`9 AM`），存储仍 UTC；`aria-label` 保留 UTC
- ✅ QW#18 Metadata template `%s · ShipFlare`，6 个主要 page 各自 `export const metadata`
- ✅ QW#19 Landing input `aria-label="Product URL"` + `inputMode="url"` + `autoComplete="url"`
- ✅ QW#20 Disabled 按钮加 `title`（mixTotal、Generate Week、Add Target）

**Commits**: `448c557 ecffe6f 824bfab da74189`

---

## 下一步（Wave 2 / Wave 3）

这批 review + merge 后再启动，主题如下（都是主题 1/5/6/7/8/9/10）：

| 主题 | 依赖 | 预期 branch |
|---|---|---|
| Today 端到端重做 | 需要 schema-index 先落地 | `feat/today-end-to-end` |
| 审核交互（useOptimistic + 键盘快捷键 + 轮询换 SSE） | frontend-polish 基础上 | `feat/review-experience` |
| 错误处理统一（error.tsx / confirm→Dialog / alert 剩余） | — | `feat/error-handling` |
| AgentStream SSE 下沉 | queue-infra 完成 | `feat/sse-restructure` |
| 数据漏斗 pipeline_events（新表 + 埋点 + 前端图） | schema-index 完成 | `feat/pipeline-funnel` |
| 平台抽象彻底收口 | — | `feat/platform-abstraction` |
| 观测：pino + traceId + cost bucket | queue-infra | `feat/observability` |

---

## Cleanup

合并完某个 branch 后清理 worktree：

```bash
cd /Users/yifeng/Documents/Code/shipflare
git worktree remove .worktrees/security
git branch -D feat/security-hardening  # 如果已 merge
```

---

## Merge 记录（2026-04-17）

4 条 feature branch 已全部合入 main，worktree 已清理，分支已删除。

**合并顺序与 commit**：

| 分支 | Merge commit | 冲突处理 |
|---|---|---|
| main WIP 先 commit 兜底 | `438a0a0` | — |
| schema-index 0010 → 0011 rename | `5db3571` | 避开和 main `0010_posting_flow_optimization.sql` 撞号 |
| feat/security-hardening | `9e9bd21` | reddit callback: 保留 main 的 post-history 抓取 + security 的 `clearStateCookie` |
| feat/queue-infrastructure | `36be653` | code-scan.ts imports 合并 / queue/types.ts 的 `isDailyDiff` 字段挪到 `codeScanJobSchema` |
| feat/schema-index-overhaul | `caab3e0` | channels schema: 同时保留 `postHistory` jsonb 列 + `uniqueIndex(userId, platform)` |
| feat/frontend-polish-wave1 | `ffb0111` | 自动 merge，无手动冲突 |
| drizzle snapshot drift 修复 | `51d3684` | 把 `post_history` 列补进 `0011_snapshot.json`，避免下次 generate 产生假 ADD COLUMN |
| 从 .gitignore 移除 .worktrees/ | `8cab78e` | — |

**Wave 1 总影响**：84 files · +7161 / -899（相对 pre-Wave-1 的 `679cb08`）。

**ESLint 对比**（跑在整个 `src/`）：
- Pre-Wave-1: 79 problems (48 errors, 31 warnings)
- Post-Wave-1: 75 problems (48 errors, **27** warnings)
- Wave 1 没引入新 error，反而清掉了 4 个 unused-imports 的 warning。

**Migration 现状**：
- `drizzle/0010_posting_flow_optimization.sql`（手写，来自 main WIP，未在 `_journal.json`）
- `drizzle/0011_simple_excalibur.sql`（drizzle-kit 生成，`_journal.json` idx=11）
- 0007/0008/0009 历史编号冲突**依旧存在**（见上方 Branch 3 段）—— 部署前还是得人工确认生产跑过哪一支。

**下一步**：
- 如果要推到远端：`git push origin main`（目前 ahead of origin by 24 commits）
- Wave 2/3 启动需要等你明确指令。
