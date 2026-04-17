# Frontend 视角体检报告

Next.js 16 App Router + React 19.2 + Tailwind v4 + SWR 2.4。整体工程化水平不错（RSC/loading.tsx/Skeleton/SSE 都有用），但在"大交互 + 长任务 + 多轮询"的场景下，体感还有不少可挖空间。React 19 的新原语（`useOptimistic`/`useTransition`/`useActionState`）基本没被利用，SWR 的 `revalidateOnFocus` 默认行为 + 多个 `refreshInterval` 叠加会出现"抽搐式"刷新；数据在多个轮询 hook 间重复请求。下面按照优先级给出。

## 1. 前端架构速览

**路由分层**（`src/app/`）
- 公共：`/`（landing，RSC + 子 client 组件）、`/onboarding`（纯 client，三步 state machine）
- `(app)` 组：服务端 auth 守卫（每个 page.tsx 自己 `auth()` + `redirect`），shell 在 `src/app/(app)/layout.tsx` 里塞了 3 个 Provider（Toast + Pipeline + AgentStream）。
- 路由页面全是 `async function` + 直接打 DB，没用到 `Suspense`/parallel routes/intercepting routes；`loading.tsx` 只有 `/today` 和 `/dashboard` 两处。

**数据流**
- 全部通过 SWR client fetch `/api/*`，没有 RSC fetch + Suspense 模式；每个 hook 独立 `refreshInterval`（15s–120s）。
- 同一个 provider（`AgentStreamProvider`）全局订阅 SSE `/api/events`，所有已登录页都开。
- 关键后台任务（scan、generate week、code scan、onboarding extract）用 fetch streaming（SSE-over-POST）读 reader，自己解析。

**组件分层**
- `components/ui/*`：原子组件，基本无依赖；Skeleton、Toast、Dialog、Toggle、Badge 都自己写。
- `components/{feature}/*`：绝大多数都顶着 `'use client'`，即便只做展示（example：`HeaderBar`、`ProductInfoSection`）。
- 页面组件常把 RSC `page.tsx` 直接 import 一个 `'use client'` 的大块（如 `XGrowthContent`、`UnifiedCalendar`），所以 server 能做的活（auth、第一屏数据）都没做。

**样式**
- Tailwind v4，但大量使用任意值（`text-[14px] tracking-[-0.224px]`、长阴影 `shadow-[0_3px_5px_rgba(...)]`）。没有抽成 token，可读性和一致性都在掉。

---

## 2. Top 问题清单

### P0-1 `/today` 页首屏"白 → loading → 空 → 列表"多跳，首屏看到实际内容要等 RTT×2
- **位置**：`src/app/(app)/today/page.tsx:1-43` + `src/app/(app)/today/today-content.tsx:1-54` + `src/hooks/use-today.ts`
- **问题**：page.tsx 已经在 server 查了 `products` / `healthScores` / `todoItems`，但 todo 列表（真正的内容）却交给 `TodayContent` 里的 `useToday()` 再去 `/api/today` 拉一次。首次进入页面走：`RSC hydration → 空的 client shell → SWR fetch → render`。
- **用户感知**：从 URL 跳进来先看到空、再闪一下 skeleton（`loading.tsx`）、再 pop 出内容，3 次视觉跳变。
- **修复**：改成 RSC 直接把第一屏 items/stats 传进去，client 用 `useSWR(key, fetcher, { fallbackData })` 做后续 revalidate；或更激进：SSR + `use()` + `<Suspense>`。同时把 `loading.tsx` 的骨架变成真实结构的"幽灵卡"。
- **工作量**：M（1 天）

### P0-2 `AgentStreamProvider` 全局订阅 SSE，但 90% 的页面用不到
- **位置**：`src/app/(app)/layout.tsx:11` + `src/hooks/agent-stream-provider.tsx:138-230`
- **问题**：只有 `/automation` 真正消费 agent 状态，但 Today/Product/Settings/Growth/Calendar 都挂着这个 EventSource。SSE 断线 3s 重连（`RECONNECT_DELAY_MS`），每次 `draft_reviewed` 事件都会 toast —— 用户在 Settings 页填表时可能突然弹窗。
- **用户感知**：后台资源占用（一个空闲连接+周期心跳）、跨页上下文噪声、手机上流量。
- **修复**：把 `AgentStreamProvider` 下沉到 `automation` 这个子路由的 layout，或让它 lazy mount（用户进入需要 live 视图的页面才连）。Toast 触发逻辑改成显式订阅（只有真正想被打扰的页面调用 `useAgentNotifications()`）。
- **工作量**：S

### P0-3 同一批数据多个轮询 hook，互相踩 + 用户回到 tab 时雪崩
- **位置**：`src/hooks/use-*.ts` 里 10 个 `refreshInterval`（15s 到 120s）；`/calendar` 同时订 `/api/calendar`(60s) 和 `/api/x/analytics-summary`；`/automation` 同时订 `/api/automation/status`(60s) 和 SSE。SWR 默认 `revalidateOnFocus: true` 还会叠加窗口切换的 revalidate。
- **问题**：窗口一回 focus，所有 hook 同时打 API；`use-monitored-tweets` 每 15s 一发；无 `dedupingInterval`；没设 SWR `Provider`。
- **用户感知**：列表数字"抖"（approve 一个 todo，马上 mutate(); 1s 内又被轮询覆盖回来）、切回 tab 时网络面板一排请求、电脑风扇响。
- **修复**：
  1. 在 `(app)/layout.tsx` 顶层套一个 `<SWRConfig value={{ dedupingInterval: 5_000, focusThrottleInterval: 10_000, revalidateOnFocus: false }}>`，需要 focus 刷新的页面局部开。
  2. 把快节奏轮询（15s tweets、30s drafts）改为 SSE push（已有 `/api/events` 基建）。
  3. `refreshInterval` 统一到两档：交互型 30s，监控型 120s。
- **工作量**：M

### P0-4 SWR 乐观更新后立刻 `mutate()` 触发二次请求，列表会"闪一下"
- **位置**：`src/hooks/use-drafts.ts:52-72`、`use-targets.ts:46-70`、`use-calendar.ts:56-78`、`use-today.ts:72-131`
- **问题**：模式都是"本地 filter 掉 → fetch → `mutate()` revalidate"。revalidate 会把后端最新 list 拉回来 render 一遍，如果后端稍慢还在处理（比如 draft 标为 approved 还没 commit），列表会先少一条、再多一条、再少一条。
- **用户感知**：按 Approve/Send 后 UI 抖动。
- **修复**：用 React 19 `useOptimistic` + `mutate(updater, { revalidate: false, populateCache: true })`，或者 SWR 的 `optimisticData + rollbackOnError: true`，并在 reconciliation 里以 id 做 merge（而不是 filter）。
- **工作量**：S

### P0-5 大量 `'use client'` 顶在展示组件上，RSC 被放弃
- **位置**：
  - `src/app/(app)/growth/layout.tsx:1`（只读 pathname 做 tab 高亮，完全可以 server component + 传 `pathname` prop 或直接用 RSC + `<Link>` + CSS）
  - `src/components/today/todo-list.tsx`、`today/post-card.tsx` （展示+按钮可拆分；group 排序纯数据逻辑应该上移）
  - `src/components/settings/connections-section.tsx`（除了 disconnect 按钮其余都是静态）
  - `src/components/product/code-snapshot-section.tsx`（大段静态展示 + 少量交互按钮）
- **问题**：这些组件的 JSX / SVG / 文本字面量全部进了 client bundle。
- **用户感知**：首屏 JS 偏大，移动端首次交互 TTI 偏慢。
- **修复**：server 的壳子 + 只把按钮抽成 `"use client"` 的 small island（官方 "server-first" 模式）。
- **工作量**：M（要耐心拆，但套路固定）

### P1-6 `FirstRun` 组件轮询 seed，没有实时推送
- **位置**：`src/components/today/first-run.tsx:15-66`
- **问题**：onboarding 完进入 Today 第一次，最多等 120s，用 `setInterval(poll, 5000)`。SSE `/api/events` 已经在 provider 里连着，完全可以复用；现在是双通道。
- **用户感知**：等 5 秒才看到第一条 task，显得"慢"；进度条完全是假的（elapsed/120）。
- **修复**：订阅 SSE 里 `agent_complete` 或新增 `todo_ready` 事件；进度条按 agent step 算（scout→discovery→content→review），体验"真实推进"。
- **工作量**：M

### P1-7 `ThoughtStream` fetch SSE + 大量 setState 在同一 tick，列表长了会卡
- **位置**：`src/components/landing/thought-stream.tsx:57-366`
- **问题**：每个 `tool_call_start/done`/`scoring` 都 `setLines(prev => prev.map(...))`。100+ 次迭代时每次都 O(n) 重建数组；每条 line 都是独立 div 没 memo。Auto-scroll `useEffect` 依赖 `lines` + `typedText`，每次事件都 scroll。
- **用户感知**：热门网站 scan 时（7-8 个社区 × 每个 3 个 query）主线程抖动，打字光标卡顿。
- **修复**：
  - 用 `flushSync` 避免批量丢更新的同时用 `startTransition(() => setLines(...))` 把非紧急更新推出。
  - 用 Map 存 `agentState`（已经做了）+ `useSyncExternalStore` 或 reducer，按 id 更新，避免 `.map()` 全量重建。
  - 超过 N 行就不 auto-scroll（用户想看上面）。
- **工作量**：S

### P1-8 Reply Queue / Target Accounts / Calendar 都没有虚拟化 + 无 memo
- **位置**：`src/components/x-growth/reply-queue.tsx:92-123`、`x-growth/target-accounts.tsx:121-164`、`calendar/unified-calendar.tsx:217-233`、`today/todo-list.tsx:37-71`
- **问题**：列表按日 group，`byDay = new Map()` 每次 render 重建；`TweetCard` / `TodoCard` 没包 `memo`，父组件 state 变（例如 `scanning=true`）整列重渲染；`items.filter(...)` 在 render body 里写了 4 次。
- **用户感知**：50-100 条 todo/calendar item 时，打字（edit modal）、toggle 都会跳一下。
- **修复**：
  - 把 `byDay` / `pendingTweets` / `pastTweets` 包 `useMemo`（或计算移到 hook 里）。
  - `TweetCard` / `CalendarItemCard` / `TodoCard` 加 `React.memo`，回调用 `useCallback`（或传 item-scoped dispatcher）。
  - 200+ 条时接入 `react-virtual` / `@tanstack/react-virtual`（当前不需要，但预埋）。
- **工作量**：S（memo/useMemo）+ M（虚拟化）

### P1-9 错误处理混用 `alert()` / `window.location.reload()` / 内联 banner / toast，没有统一降级
- **位置**：
  - `src/components/settings/connections-section.tsx:24,27,29`（`alert` + `reload`）
  - `src/components/product/{product-info,website-info,code-snapshot}-section.tsx`（原生 `confirm`）
  - 多处 "setError(msg)" 显示红条，但 API 401/网络断时没有专门表现
  - 没有任何 `error.tsx`、没有 `ErrorBoundary`
- **用户感知**：弹系统 alert 打断操作；reload 丢当前滚动位置；网络断开时 UI 无反馈（SWR 静默失败）。
- **修复**：
  1. 用 `Dialog` 替换 `confirm`，用 `useToast()` 替换 `alert`。
  2. 每个路由段加 `error.tsx`，全局加一个 `global-error.tsx`。
  3. 顶层检测 `navigator.onLine` 或 SWR `onErrorRetry` 全局失败 → 展示"网络似乎掉了"顶栏。
- **工作量**：M

### P1-10 表单交互体感差 —— 无 Enter 提交 / 无 keyboard focus 管理 / 无 disabled 原因
- **位置**：
  - `src/components/x-growth/target-accounts.tsx:74` `onKeyDown Enter` 只处理了 username 输入，category select 没焦点顺序
  - `src/components/automation/agents-war-room.tsx` Dialog 打开时焦点没 trap 到 Dialog，Esc 不关
  - `PostCard` edit textarea 没 autoFocus，Save 无 Cmd+Enter
  - `settings/automation-section.tsx:264` 存按钮 disabled 时 `mixTotal !== 100` 没说"请凑齐 100%"
- **用户感知**：键盘用户抓狂；"为什么按钮灰着"。
- **修复**：Dialog 组件加 focus trap（推荐用 `@radix-ui/react-dialog` 或手写 `useFocusTrap`）；textarea 加 `Cmd/Ctrl+Enter` 提交；disabled 按钮加 `title` 或 tooltip 说明原因。
- **工作量**：M

### P1-11 Landing page 水合浪费 + 重依赖拉进客户端
- **位置**：`src/app/page.tsx` + `src/components/landing/landing-page.tsx:29-361`
- **问题**：整个 LandingPage 是 `'use client'`，但大部分内容（hero、footer、metadata）是纯展示。`ThoughtStream` / `DiscoveryCard` 只在 scan 流程中才用到，却一并打进首屏 bundle。
- **用户感知**：landing 页 LCP/TTI 略慢（尤其移动 4G）。
- **修复**：
  - 把 hero/footer 保留 RSC；把 scan input + result 抽成一个 client island。
  - `ThoughtStream` / `DiscoveryCard` 用 `next/dynamic({ ssr: false })` 在点击 Scan 后再加载。
- **工作量**：M

### P2-12 Metadata API 只有 root，所有子页 title 都是 "ShipFlare"
- **位置**：`src/app/layout.tsx:4-14`
- **问题**：`/today`、`/calendar`、`/growth/x` 浏览器 tab 都是 "ShipFlare"，多标签用户分不清。
- **修复**：每个 page.tsx 加 `export const metadata = { title: 'Today · ShipFlare' }` 或 root 用 `title.template: '%s · ShipFlare'`。
- **工作量**：S

### P2-13 a11y 零碎
- Landing `<input placeholder="yourproduct.com">` 没 `aria-label`（`src/components/landing/landing-page.tsx:164`）
- `MediaStrip` 的 "remove media" 按钮字面量是 `x`（看起来像字母 x），iconText 不可读（`post-card.tsx:259`）
- 所有 dot indicator（`w-2 h-2 bg-sf-error animate-pulse`）没 text 等价
- 颜色对比：`text-sf-text-tertiary`（淡灰）+ `tracking-[-0.12px]` 12px 在 `bg-sf-bg-secondary` 上估计 < 4.5:1
- **修复**：加 `aria-label`；pulsing dot 加 `<span className="sr-only">Urgent</span>`；颜色 token 过 Contrast checker。
- **工作量**：S

### P2-14 Tailwind 任意值泛滥 / 设计 token 未抽
- **位置**：`shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]` 在 15+ 处重复；`text-[14px] tracking-[-0.224px]` 在 100+ 处重复。
- **问题**：改一次 shadow 要改十几个文件；设计不一致（`hover:bg-black/[0.04]` vs `bg-sf-bg-secondary` 混用）。
- **修复**：在 tailwind.config 或 `globals.css` 的 `@theme` 里抽 `--shadow-sf-card-base`、`--text-body-sm` 等 token；统一使用 `text-body-sm`、`shadow-card`。可以配合 design-consultation skill。
- **工作量**：M

---

## 3. 快赢（<1 天）

1. **全局 `<SWRConfig>`**：在 `src/app/(app)/layout.tsx` 加 `{ dedupingInterval: 5000, focusThrottleInterval: 10000, revalidateOnFocus: false }`，让每次切 tab 不打一把枪（P0-3 的一半）。
2. **Metadata 模板**：root layout 加 `title: { template: '%s · ShipFlare', default: 'ShipFlare' }`，每个 page 一行 `export const metadata`（P2-12）。
3. **`alert()` / `confirm()` → Toast/Dialog**：4 处替换（P1-9）。
4. **按钮 `disabled` 加 `title`**：生成周、保存 preferences、Add Target 三处（P1-10）。
5. **移除/下沉 `AgentStreamProvider`**：改到 `/automation/layout.tsx`（P0-2）。
6. **`useMemo(byDay, [items])` 三处**：unified-calendar.tsx、content-calendar.tsx、todo-list.tsx（P1-8 的 memo 部分）。
7. **First-run 进度条按 SSE 推进**：把 120s 假进度换成真事件（P1-6 初版）。
8. **Landing input 加 `aria-label="Product URL"`**（P2-13）。

---

## 4. 组件级重构建议（>1 天）

### R1. `/today` 全链路改 RSC + Suspense + `useOptimistic`
- `page.tsx` 里直接 `const items = await getTodos(userId)`；包在 `<Suspense fallback={<TodayLoadingSkeleton />}>` 里 stream 过来。
- client 部分只保留 `TodoActionClient`（按钮 + optimistic state）。
- approve/skip/edit 用 Server Action + `useOptimistic` —— 按下按钮条目立即消失，失败时从 cache rollback。
- 收益：首屏内容提前 1×RTT，按钮零抖动。

### R2. 长任务统一抽一个 `useTaskStream` hook
- 当前 `ThoughtStream`、`CodeSnapshotSection` rescan、onboarding `ProfileReviewStep` 都自己 reader.read() 解析 SSE-over-POST。
- 抽一个 `useTaskStream<TEvent>(url, body, { onEvent, onComplete })`，内部处理 abort、buffer、try/catch、reducer。
- 配合 `useTransition`，事件密集时 UI 不阻塞。

### R3. 真正统一的 Shell（顶层 Provider 合并）
- 目前三层嵌套：ToastProvider → PipelineProvider → AgentStreamProvider。Pipeline 和 AgentStream 有明显职责重叠（都是"某个任务在跑"）。
- 建议合并为 `OperationsProvider`：本地 run()（短任务）+ 远程 SSE（长任务）统一放一个 reducer，页面左下只看到一个 Banner。减少心智负担和重叠渲染。

### R4. 设计系统落地：`components/ui` + `theme.css`
- 把 20+ 处重复的 shadow / padding / typography 抽成 CSS variables 和 `@utility`（Tailwind v4 支持）。
- 补齐缺失的 primitives：`Tooltip`、`Popover`、`Sheet`（移动端侧栏）、`DatePicker`（reschedule 现在"Tomorrow" 简化版）。

### R5. 虚拟化 + 无限滚动（前置）
- Reply Queue "past tweets" 已经手动 `slice(0, 10)`；Calendar `14d` 窗口；Today groups 全展开。
- 当用户量起来（500+ drafts 历史）需要虚拟滚动 + 分页游标。先把 list hook 改成 `useSWRInfinite` 结构，即便后端暂未分页也有地方接。

---

## 5. 需要后端/数据配合的点

| # | 需求 | 为什么 |
|---|------|--------|
| B1 | `/api/today` 返回支持 `fallbackData`：page.tsx server fetch 得到的 items 结构跟 client hook 一致（目前已经差不多，但 `cardFormat` 是 client 推导的） | 消除 Today 首屏二次闪烁（P0-1） |
| B2 | SSE 频道细分：`/api/events?channel=tweets` / `?channel=drafts` / `?channel=agents` | 让 reply-queue / drafts 替代 15s 轮询，减少不必要流量（P0-3） |
| B3 | `/api/drafts` 批量 action：`{ ids: string[], action: 'approve'|'skip' }` | 目前只能逐条 approve，Today 列表一次清空要 N 次请求 |
| B4 | `/api/today/action` 返回最新的 list 片段（而不是仅 200 OK） | SWR mutate 可以 populate 而不用再 fetch（P0-4） |
| B5 | `/api/calendar/generate` 返回 jobId + SSE 进度 | 现在"Generate Week"按钮 3 个 `setTimeout` mutate（`use-calendar.ts:47-49`）是脏 hack |
| B6 | `/api/x/engagement` 和 `/api/x/targets`、`/api/x/monitor` 合并为一个 BFF `/api/x/dashboard` | 目前 Growth 页 1 秒内 3 个请求，可合并减瀑布 |
| B7 | `/api/reddit/disconnect`、`/api/x/disconnect` 响应后端返回更新后的 channels list | 省掉 `window.location.reload()`（P1-9） |
| B8 | `/api/onboarding/extract` 返回 SSE 进度（网站扫描长的时候用户干瞪眼） | 对齐 scan 体验，`ProductSourceStep` 目前 "Scanning..." 就是一个 button loading（P1-6 同源） |

---

## 一句话总结

**最大的 ROI 是：消掉首屏抖动（P0-1）+ 关小轮询水龙头（P0-3）+ 下沉 SSE provider（P0-2）**。这三个改完，用户在 Today/Growth/Calendar 三个主路径上的"抽搐感"会立刻消失；其余优化是锦上添花。
