# PM 视角体检报告

> 范围：ShipFlare 全站用户体验与交互路径审计。聚焦"用户能感知到的问题"，不涉及内部实现细节。
> 方法：通读 `src/app/(app)`、`src/components/{today,calendar,x-growth,automation,dashboard,onboarding,settings,product}`、onboarding API 表单与路由，推演从登录到"发现→生成→发布→看数据"的完整路径。

---

## 1. 核心用户旅程现状

```
                           ┌──────────────────────┐
                           │  Landing / Sign in   │
                           └──────────┬───────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────┐
                  │ /onboarding  (3 dots, 3 steps)     │
                  │ ① Source  ② Review  ③ Connect      │  ← Reddit/X 都可 Skip
                  └──────────┬─────────────────────────┘
                             │ router.push('/today')
                             ▼
           ┌─────────────────────────────────────────────┐
           │ /today  (首跑 = FirstRun 120s 轮询等待)      │
           │ 三组：time_sensitive / scheduled / optional │  ← 逐条 Approve / Edit / Skip
           └──────────┬──────────────────────┬───────────┘
                      │ 看不到原因？             │ 想排一周？
                      ▼                      ▼
     ┌──────────────────────┐     ┌──────────────────────┐
     │ /growth/x  (4 tabs)  │     │ /calendar            │
     │ Targets / Replies /  │     │ Generate Week 按钮   │
     │ Engagement/Analytics │     │ 14d 列表按天分组      │
     └──────────┬───────────┘     └──────────┬───────────┘
                │                             │
                ▼                             ▼
     ┌──────────────────────┐     ┌──────────────────────┐
     │ /automation          │     │ /product             │
     │ Pipeline Status +    │     │ 扫代码/改简介/看SEO  │
     │ 5-agent 大屏         │     │                      │
     │ "Run Automation"     │     │                      │
     └──────────────────────┘     └──────────────────────┘
                │
                └── (无汇总视图，"数据"散落在 x-growth Analytics tab)
```

**每步关键痛点**

1. **Onboarding (`src/app/onboarding/page.tsx`)**：首屏同时给出 GitHub / URL / "或手动输入"三个入口。URL 路径有明确 CTA，GitHub 路径需 OAuth 跳转再选仓库，手动路径会让用户进入空白 `ProfileReviewStep`。步骤标题"Add your product / Review your profile / Connect your accounts"混用了产品名词和社交名词。
2. **"Connect accounts" 步骤可 Skip (`connect-accounts-step.tsx:81`)**，且小字才说"posting requires it"。但后续 `/today` 的 FirstRun 会静默 seed、轮询 120s，直到失败才引导到 Calendar —— 用户不知道失败是因为没连账号还是因为任务真的没跑出来。
3. **`/today` 首跑 (`first-run.tsx`)** 等待长达 2 分钟，progress bar 是纯时间驱动而不是真实进度；超时文案"Your marketing team is still warming up"含糊，没告诉用户下一步该做什么。
4. **`/today` 主循环**：卡片里 Approve / Edit / Skip 都需点击鼠标，没有键盘快捷键（`src/components/today/post-card.tsx`、`reply-card.tsx`）。Post 的 "Tomorrow" 按钮只能推 +1 天（`post-card.tsx:213-219`），无法选具体日期/时段。
5. **Growth → Calendar → Automation 三页存在概念重合但各自独立**：Calendar 的 "Generate Week" 按钮 (`unified-calendar.tsx:179`) 只生成、不发布；Automation 的 "Run Automation" (`agents-war-room.tsx:76-97`) 跑整条 pipeline；用户不清楚两者差别、什么时候点哪个。
6. **跳转摩擦**：`EngagementAlerts` 用 `<a href="/today">View all in Queue`（`engagement-alerts.tsx:80`）跳出 Growth 页；`CodeSnapshotSection` 用 `<a href="/settings">`（`code-snapshot-section.tsx:151`）做内链 —— 两处都会整页导航而不是保留当前 context。
7. **"发现 → 数据"闭环断裂**：发布成功后用户要去 Growth/Analytics (`metrics-panel.tsx`) 手动切 7d/30d/90d，Today 和 Calendar 都不告诉我"昨天发的那条效果如何"。`CompletionState` 只显示计数（`completion-state.tsx:30-40`），没点击入口。

---

## 2. Top 问题清单

### P0 — 阻塞主路径

#### P0-1. FirstRun 等待盲区（最大首跑流失点）
- **问题**：`src/components/today/first-run.tsx:21-68` 设 `maxWaitMs = 120_000`，每 5s 轮询一次，progress bar 按时间线性推进（不反映真实阶段）。失败分支只给 "No tasks yet"，没有任何可操作的 CTA（除 Open Calendar）。
- **用户影响**：首跑用户 100% 命中，绝大多数等 1-2 分钟看一个静态转圈；如果他们没连账号，根本不会有任务，但 UI 不提示这件事。
- **建议方案**：产品决策 = "把等待变成可观察 + 永远给出 next step"。
  - 前端：FirstRun 展示真实阶段（scanning / found N threads / drafting / ready），复用现有 agent-stream SSE（`agent-stream-provider`），替换时间 progress。
  - 前端：超时后根据账号连接状态分支：未连账号→"Connect X / Reddit to start" 按钮；已连→"Try again" + 联系支持。
  - 后端/数据：seed 接口返回预估队列长度，前端据此做百分比。
- **工作量**：M

#### P0-2. Calendar "Generate Week" 与 Automation "Run Automation" 心智模型冲突
- **问题**：`unified-calendar.tsx:179` 和 `agents-war-room.tsx:76-97` 是两个看起来一样的大按钮，但功能差别大（前者只排 14 天内容、后者真跑 agent pipeline 含 Scout/Discovery/Content/Review/Posting）。页面间没有交叉说明。
- **用户影响**：所有想"一键让它工作"的新用户都会懵，点错按钮后果不一样（一个增加 Draft，一个可能真发帖）。
- **建议方案**：产品决策 = "把两个按钮合并成一个 Automation 面板，Calendar 页只显示结果"。
  - 前端：Calendar "Generate Week" 改成 "Plan next 14 days"，副标题明确 "creates drafts, does not post"。
  - 前端：Automation 的 agent 大屏加顶部小卡"这会做什么 / 本次预估花费"，让 Run 按钮前给用户预期。
  - 前端：Today 页加 "Plan ahead" 快捷入口指向 Calendar。
- **工作量**：M

#### P0-3. 发布失败 & 没连账号的错误归因不清
- **问题**：
  - `agents-war-room.tsx:34-38` 用 `NO_CHANNEL` 错误码弹窗提示 "Connect an account"，但只覆盖 "Run Automation" 按钮的场景；
  - Today 页的 Approve (`post-card.tsx:199`, `reply-card.tsx:141`) 和 Calendar 的 cancel 只在行内显示错误字符串，不区分"配额到了 / token 过期 / 没连账号"；
  - `discovery/approve/route.ts:64-81` 如果用户没 channel 只写 `log.warn` 然后仍返回 success，前端以为发布成功。
- **用户影响**：真实发帖失败场景下用户以为自己发成功了，第二天看不到效果找不到原因。
- **建议方案**：产品决策 = "任何涉及发帖的 approve 路径，在没有相应 channel 时必须 fail-fast + 给出 Connect 按钮"。
  - 后端：approve 路由按 `thread.platform` 匹配 channel，缺失时返回 `{code: 'NO_CHANNEL_X'}`。
  - 前端：Toast 从纯文本升级为带 action（"Go to Settings / Reconnect"）。
  - 前端：Settings Connections 连接状态支持"过期"状态（不只 Connected/Not connected）。
- **工作量**：M

### P1 — 严重降低效率 / 信任

#### P1-1. 审核没有批量操作、没有键盘快捷键
- **问题**：`todo-list.tsx` 按优先级分组，每张卡只能逐个 Approve/Skip；`reply-queue.tsx`、`engagement-alerts.tsx`、`draft-queue.tsx` 一律鼠标点击。对于目标用户（每天清 10-30 条 draft 的独立创作者），这是最高频动作。
- **用户影响**：每天用户要点击 30+ 次才能把 Today 清空，强体感疲劳。
- **建议方案**：产品决策 = "Today 和 Reply Queue 首先加键盘快捷键，再做全选批量"。
  - 前端（S）：`j/k` 上下移动、`a` approve、`e` edit、`s` skip、`?` 显示帮助面板。需要一个全局 keybinding hook。
  - 前端（M）：`todo-list.tsx` 每组加 "Approve all" 按钮（带 N 项确认），替换整组。
  - 前端（M）：每张卡加多选复选框 + 顶部浮动 action bar。
- **工作量**：S (快捷键) / M (批量)

#### P1-2. "Why this works" 藏得太深，用户不会信任 AI draft
- **问题**：`post-card.tsx:188`、`reply-card.tsx:130`、`draft-card.tsx:142` 都把原因放在一个可折叠 `Toggle` 里，默认收起。用户一眼只看到一段 AI 写的文字 + Approve 按钮。
- **用户影响**：新用户不敢按 Approve，老用户机械性按 Approve（失去审核价值）。
- **建议方案**：产品决策 = "前两周强制展开，之后允许关闭；另外在 card 头部提供一句话原因"。
  - 前端：`whyItWorks` 前 N 条默认展开；增加 `summaryReason` 字段（1 句话），显示在 action bar 上方而不是折叠里。
  - 后端：content agent 输出结构化 `summaryReason` + 当前的 `whyItWorks`。
  - 数据：drafts 表加 `summary_reason`（或从 whyItWorks 派生）。
- **工作量**：M

#### P1-3. `source` 维度对用户是术语，不是意义
- **问题**：`draft-queue.tsx:8-14` 的过滤器"Monitor / Calendar / Engagement / Discovery"四个词对用户是黑话。`DraftCard` 又加了 platform 图标 + community badge + source badge + draft type 四块头部元数据（`draft-card.tsx:46-62`），视觉噪音大。
- **用户影响**：用户不知道该按哪个筛，结果默认看 All，失去分流效果。
- **建议方案**：产品决策 = "把 source 换成动词场景，把 metadata 精简成两个 badge"。
  - 前端：tab 换成 "Scheduled posts / Replies to targets / Engage with my audience / Community threads"。
  - 前端：`DraftCard` 头部只保留 platform + community + urgency；source/type 合并成一个标签。
- **工作量**：S

#### P1-4. Automation agent 大屏用户"看不懂 + 干预不了"
- **问题**：`agents-war-room.tsx` + `agent-card.tsx` 有 5 格，每格显示 name/currentTask/progress/stats/cost/duration/log。用户视角：
  - 看得见 Scout/Discovery/Content/Review/Posting 在"跑"，但不知道这条 pipeline 预计产出什么；
  - 没有 Pause / Cancel 按钮；`handleTrigger` (`agents-war-room.tsx:25-50`) 只管启动；
  - Log 默认折叠，展开后是纯技术字符串；
  - Pipeline Status 模块（`pipeline-status.tsx`）上方显示 2x2 定时任务，用词 "Pipeline / cron" 技术化。
- **用户影响**：用户要么焦虑地盯着看，要么根本不理解这页存在的意义；出错时 `Badge variant="error"` 只显示 "N err"，点不开详情。
- **建议方案**：产品决策 = "把 war room 做成'解说 + 可干预'两栏：左解说 plain English，右高级模式保留现状"。
  - 前端：顶部加预期产出卡片（"Expected: ~12 drafts, ~$0.08 cost, ~3min"）。
  - 前端：加 Stop / Cancel 按钮（后端已有队列，需暴露 API）。
  - 前端：Error Badge 可点击打开详情抽屉（当前 err count 无上下文）。
  - 前端：`pipeline-status.tsx:73` 的 cronDescription 用人话替换，例如"每天早上 9 点 / 每 15 分钟"。
- **工作量**：L

#### P1-5. 信息架构：概念 "skill / swarm / pipeline / processor / channel" 在 UI 各处漏出
- **问题**：
  - Sidebar 5 大入口：Today / My Product / Growth / Calendar / Settings，暂时清晰；
  - 但进入页内后，用户会看到 "Pipeline Status"、"Agents War Room"、"channel"（`unified-calendar.tsx:12`、`platform-config` 概念漏到 automation 的 NO_CHANNEL 弹窗 `agents-war-room.tsx:134` 用 "connected account" 但其他地方用 "channel"），术语不一致。
  - "Growth" 顶部又有二级 tab "X / Twitter"（`growth/layout.tsx`），只有一个 tab，显得多余。
- **用户影响**：增加认知负担；新用户理解"我的 channel 是什么"需要多跳几页。
- **建议方案**：产品决策 = "对外一套词：Account（社交账号）、Plan（定时作业）、Automation（自动流水线），内部自便"。
  - 前端/文案：全站替换 channel→account，pipeline→schedule，processor→task。
  - 前端：`/growth` 页只有一个 X 时，去掉顶部 tab，直接展示；加新平台时再恢复。
- **工作量**：S（文案替换）+ S（去 tab）

#### P1-6. "发布→数据"闭环缺失
- **问题**：发出去的帖子数据在 `metrics-panel.tsx`（Growth 页 Analytics tab），但 Today 的 `CompletionState` (`completion-state.tsx`) 只写 "N posts published yesterday" 一行文字，没有点击进去看的入口；Calendar 的 "posted" 状态 badge（`unified-calendar.tsx:174-177`）也不能点开查看那条帖子的表现。
- **用户影响**：用户做了很多天审核后拿不到正反馈，"这事值不值得"的体感很弱 —— 流失风险点。
- **建议方案**：产品决策 = "每个已发布项都必须能一键跳到它的表现"。
  - 前端：Calendar item `status=posted` 时，展开区域显示该帖子的 impressions/likes/bookmarks（用 `metrics-panel` 的数据源按 tweetId 查）。
  - 前端：`CompletionState` 加"Yesterday's top post" 卡片带小型 metrics。
  - 前端：Today 顶部 HealthScore 可点击打开健康度说明弹窗（现在 `header-bar.tsx:12-18` 只展示不交互）。
- **工作量**：M

### P2 — 打磨项

#### P2-1. Onboarding 手动路径几乎没引导
- **问题**：`product-source-step.tsx:98-115` 的"or enter manually →" 直接把空 profile 传给下一步。`profile-review-step.tsx`（未读但可推断）要在空白表单里填 name/description/keywords/valueProp 五个字段。
- **用户影响**：低（GitHub / URL 两条路径覆盖多数），但一旦走 manual 会失望。
- **建议方案**：manual 路径加 placeholder 示例文案 + "Skip and come back in Settings" 选项。
- **工作量**：S

#### P2-2. 手动"reschedule to tomorrow"粒度太粗
- **问题**：`post-card.tsx:213-219` 只能 +1 天，原计划时间丢失；`unified-calendar.tsx:281-288` 的删除按钮是一个小叉号无二次确认。
- **用户影响**：误删会发生，且无 undo。
- **建议方案**：
  - Today 加 reschedule 日期选择器（HTML `<input type="datetime-local">` 即可）。
  - Calendar 删除改为 "Skip this slot" + 5 秒 undo toast。
- **工作量**：S

#### P2-3. 响应式移动端显著劣化
- **问题**：`layout.tsx:13-14` sidebar 只在 `lg:` 显示；移动端用 `top-nav.tsx` 展示 5 个平铺 link，文字 12px，没触达安全区；`agent-grid.tsx:28` 的 grid 在 mobile 是 1 列，5 张 agent 卡片要滚很远；`unified-calendar.tsx` 的 3 列 Performance Insights (`unified-calendar.tsx:119`) 在窄屏会挤爆（没有 `sm:grid-cols-1`）。
- **用户影响**：从手机上"快速审一条"的场景（外出时收到 engagement alert）无法完成。
- **建议方案**：产品决策 = "先把 Today 做成移动端可用，其他页可以桌面优先"。
  - Today：卡片间距、按钮高度、字号已经基本 OK，重点补输入法编辑的视口处理。
  - Calendar / Growth / Analytics：加 responsive 栅格兜底，手机上改 1 列 + 横向滚动。
  - 顶导航：考虑 iOS 底部 tab bar（5 项正好）。
- **工作量**：L

#### P2-4. 连接账号/取消连接的错误处理降级到 `alert()`
- **问题**：`connections-section.tsx:25,28` 用 `alert()` 弹原生错误框，与全站 toast 体系断裂；`danger-zone.tsx` 有专门 dialog 但连接失败没有。
- **用户影响**：观感割裂，用户可能以为页面坏了。
- **建议方案**：替换成 `useToast().toast(err, 'error')`。
- **工作量**：S

#### P2-5. Target Accounts 输入无校验 / 无验证反馈
- **问题**：`target-accounts.tsx:68-95` 输入框接受任何字符串；没校验该账号是否存在、没预取头像/粉丝数。添加后如果拼错要手动删掉重来。
- **用户影响**：静默失败 —— 用户以为在监控，其实拼错了 handle。
- **建议方案**：输入时 debounce 调用 X 查询 API，实时展示候选账号（头像 + display name + 粉丝数）；失败时 inline 报错。
- **工作量**：M

#### P2-6. Settings "Posting hours" UTC 反人类
- **问题**：`automation-section.tsx:162` 让用户选 "Posting hours (UTC)"，虽然下面 tooltip 是本地时间，但选择器上的数字仍是 UTC 小时。
- **用户影响**：非 UTC 时区用户（绝大多数）看错小时，结果帖子发在半夜。
- **建议方案**：UI 统一显示本地时间，存储仍 UTC；`TimezoneSection` 改的时区应驱动这个选择器。
- **工作量**：S

#### P2-7. Discovery Feed 只能"点开外链"
- **问题**：`discovery-feed.tsx` 每行是 `<a target=_blank>` 跳 Reddit，用户无法在 ShipFlare 内决定"要不要从这条生成草稿"。与 draft queue 完全分离。
- **用户影响**：Discovery 只读、无转化动作，功能价值被稀释。
- **建议方案**：每行加 "Draft a reply" 按钮触发 content agent，直接进 `/today`。
- **工作量**：M

---

## 3. 快赢清单（每条 <1 天）

1. **Today 键盘快捷键 `a/s/e/j/k`**（P1-1 子项）：一个全局 `useKeyboardShortcuts` hook + `todo-list.tsx` 聚焦态管理。
2. **连接账号用 Toast 而不是 `alert()`**（P2-4）：`connections-section.tsx:25,28` 两行替换。
3. **Growth 页在只有 X 一个 channel 时隐藏二级 tab**（P1-5 子项）：`growth/layout.tsx:17-38` 加条件渲染。
4. **Calendar 删除按钮加 5 秒 undo toast**（P2-2）：`unified-calendar.tsx:280-288` 的 `onCancel` 先软删 + toast with undo action。
5. **Posting hours 按本地时间显示**（P2-6）：`automation-section.tsx:179-190` 按钮文字用 `formatHourLocal(h)`，把 UTC 原值作为 title/hidden。

---

## 4. 需要进一步验证的假设

1. **首跑 120s 等待的真实完成率分布**：`first-run.tsx` 有 timeout 态，但不知道有多少比例用户卡在这里。需要埋点 `first_run_{seeded, ready, timeout}` 事件 + 计算 P50/P90/P99。如果 P90 > 90s，P0-1 从"改文案"升级到"架构改造（改为后台 job + 通知）"。
2. **审核瓶颈在"数量"还是在"质量"**：如果用户平均每天 approve 30 条，需要批量；如果只有 5 条但质量不稳定，应优先做 `summaryReason`（P1-2）而不是快捷键（P1-1）。需要事件：per-draft 决策时间、approve/skip 比率、编辑后发出的占比。
3. **用户是否真的在看 agent war room**：`agent-grid.tsx` 的信息密度对用户是否有价值？可能 war room 只对 power user 有用，普通用户只需"进度条 + 做完了喊我一声"。建议先做 90/10 拆分：默认简化视图 + "Advanced" 切换。埋点验证。
4. **Reddit vs X 的相对重要性**：Sidebar 没有 Reddit 独立入口，Growth 页只 X，但 onboarding 连 Reddit 的 CTA 和 X 并列。如果 Reddit 是主用例，整个 Growth 信息架构可能倒过来。需要：分平台的 draft/posted/approve 计数看板。
5. **"My Product"页面的访问频率**：`src/app/(app)/product/page.tsx` 看起来是一次配置型页面。如果周活访问 < 5%，现在入口占 Sidebar 主位置是浪费。考虑折叠到 Settings。
6. **移动端使用比例**：决定 P2-3 优先级的关键。如果 < 10%，保持桌面优先；> 30% 则把 Today 移动化提到 P1。

---

**总结**

ShipFlare 的信息架构基础是扎实的（5 入口清晰、Today 作为 daily driver 方向对）。最值得先修的是：
- **P0-1 首跑可视化**（决定留存）
- **P0-2 Generate Week vs Run Automation 清晰化**（决定用户能否理解产品）
- **P0-3 发布失败的错误归因**（决定信任）
- **P1-1 键盘快捷键 + P1-2 一句话 reason**（决定长期效率和信任）
- **P1-6 发布→数据闭环**（决定正反馈，影响活跃）

这五条做完，产品从"能用"跨到"顺手"。
