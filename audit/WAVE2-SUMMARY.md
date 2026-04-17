# Wave 2 实施汇总

3 条 feature branch 已全部合入 main，worktree 已清理，分支已删除。

## Branch 1: `feat/platform-abstraction`

**7 commits · ~20 files**

- ✅ `src/lib/platform-config.ts` 扩容：新增 `buildContentUrl` hook / `externalIdPattern` / `supportsAnonymousRead` 标志 / `listPlatforms()` / `listAvailablePlatforms()` 遍历器
- ✅ `src/lib/platform-deps.ts` 新增 `createClientFromChannel(platform, channel)` 和 `createPublicPlatformDeps(platforms?)` —— processors 不再直接手搓 `if (platform === 'x')`
- ✅ `src/workers/processors/posting.ts` 改走 `createClientFromChannel` 路由
- ✅ `src/workers/processors/full-scan.ts` 改走 `createPublicPlatformDeps`
- ✅ `src/app/api/x/engagement/route.ts` 用 `posts.platform` 过滤（替换原先 `externalId ~ /^\d+$/` 的启发式）
- ✅ 所有 `if (platform === 'x')` 的客户端构造逻辑下沉到 `platform-deps.ts`
- ✅ Channel 检查 / 友好文案从 `PLATFORMS` registry 驱动：UI toast 不再硬编码 "Connect Reddit"

**Merge commit**: `c5ed092`，无手动冲突。

## Branch 2: `feat/error-handling`

**2 commits · ~10 files**

- ✅ `src/components/ui/alert-dialog.tsx` 新增 shadcn-style `AlertDialog`（原生 `<dialog role="alertdialog">`，destructive variant，Confirm/Cancel 焦点陷阱）
- ✅ `src/components/product/*` 把 `window.confirm` / `window.alert` 替换成 `AlertDialog` + toast
- ✅ `src/app/**/error.tsx` + `not-found.tsx` + `loading.tsx` —— Next.js 16 App Router 错误边界铺开
- ✅ `src/hooks/use-today.ts` 新增 `TodayActionError` 类；mutation 在非 2xx 时抛出并通过 `mutate()` 回滚乐观隐藏
- ✅ Publish 失败走 toast 归因：`Reply failed: Reddit said 429 Too Many Requests`

**Merge commit**: `b78d9bc`，无手动冲突。

## Branch 3: `feat/observability`

**3 commits · ~25 files**

- ✅ `src/lib/logger.ts` 重写成 pino-shape 结构化 JSON logger：`createLogger(module)` → `Logger` 实例，支持 `child({})` 继承 context，env `LOG_FORMAT=json|pretty`
- ✅ `loggerForJob(base, job)` / `loggerForRequest(base, req)` / `traceIdFromRequest(req)` helpers
- ✅ `src/lib/queue/types.ts` 所有 job schema 新增 `traceId: z.string().min(1).optional()` 字段；`getTraceId(data, jobId)` fallback 到 BullMQ job id
- ✅ `src/lib/cost-bucket.ts` 新增 Redis HASH 成本桶：`addCost(runId, usage)` / `getCostForRun(runId): CostSnapshot` / `dropCostBucket(runId)`；key = `cost:run:{traceId}`，HINCRBYFLOAT + HINCRBY，TTL 7 天
- ✅ 所有 13 个 processor 串起 traceId：`loggerForJob(baseLog, job)` + `getCostForRun(traceId)`（posting.ts 在 post-published 时读取整条 run 的累计成本）
- ✅ 所有受影响的 API route 串起 `loggerForRequest(baseLog, request)` → response 带 `x-trace-id` header

**Merge commit**: `61c42e6`，手动解决 4 个冲突（都是加性冲突，选择保留两边语义）：

| 文件 | 冲突 | 处理 |
|---|---|---|
| `src/app/api/x/engagement/route.ts` | `PLATFORMS` import 单侧缺失 | 保留 HEAD 的 import，下面的 `PLATFORMS.x.id` 才有定义 |
| `src/app/api/drafts/route.ts` | imports 两边都有变动 | 合并为 `{ createLogger, loggerForRequest }` + `PLATFORMS` |
| `src/app/api/discovery/approve/route.ts` | observability 重复声明 `const [channel]`（主干已重构成 409 NO_CHANNEL early-return） | 保留 HEAD 的 409 NO_CHANNEL 业务流，只把 `traceId` 追加进 `enqueuePosting` 调用 |
| `src/workers/processors/posting.ts` | `platform: 'x'` vs `platform: PLATFORMS.x.id` | 保留 HEAD 的 `PLATFORMS.x.id`，追加 `traceId` |

## Wave 2 总影响

**53 files · +1615 / -237**（相对 Wave 1 合并完成点 `ffb0111`）

**TypeScript 状态**：
- `tsc --noEmit` exit 0（无类型错误）

**ESLint 对比**（跑在 `src/`）：
- Post-Wave-1: 75 problems (48 errors, 27 warnings)
- Post-Wave-2: **62 problems (48 errors, 14 warnings)**
- Wave 2 没引入新 error，反而清掉了 13 条 unused-vars 类 warning。

**Worktree 清理**：
- `.worktrees/error-handling` / `observability` / `platform-abstraction` 全部 `worktree remove --force`
- `feat/error-handling` / `feat/observability` / `feat/platform-abstraction` 分支已 `branch -D`
- 当前只剩主 worktree `/sessions/bold-stoic-johnson/mnt/shipflare` 在 main

## Migration 现状

无新增 migration（Wave 2 全是代码层改动）。仍然是：
- `drizzle/0010_posting_flow_optimization.sql`
- `drizzle/0011_simple_excalibur.sql`

0007/0008/0009 历史编号冲突仍然悬而未决，部署前需要人工对齐生产 migration 状态。

## 下一步

- 推远端（如果要推）：`git push origin main` ——目前 ahead of origin 由 Wave 1 的 24 commits 增长到 Wave 1 + Wave 2 的 ~37 commits。
- Wave 3 马上开跑（4 条并行 branch：today-end-to-end / review-experience / sse-restructure / pipeline-funnel）。
