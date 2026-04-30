# TODOS

---

# Next stage

### 1. Plan / Post / Reply 生成策略优化 — 共情 > 自我表达

**问题:** 当前生成的 post 和 reply 太 arrogant — 自我中心、上帝视角、说教语气、隐性自夸 ("we built X that solves Y"、"the right way to think about this is…")。缺少对原帖作者处境的真正共情，看起来像 AI 营销号而不是社区里的同类。

**症状清单 (要带样本进会议):**
- Reply 第一句经常直接给结论 / 解决方案，不先承认对方处境的难度
- Post 倾向于宣告式开头 ("Here's what we learned…"),而不是观察式 / 提问式
- 频繁出现品牌植入感 — 把自家产品作为"答案"，而不是把回答本身做扎实
- Tone slider (warmth/wit/formality/brevity) 在生成时被弱化，输出向"自信权威"方向漂移
- 没有体现"在同一个坑里"的同侪感 — 缺少 "I've been there", "what worked for me was…" 这类语气

**主要触点 (按生成路径排序):**
1. `src/tools/AgentTool/agents/community-manager/AGENT.md` — reply drafting 系统提示
2. `src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md` — 质量门槛
3. `src/tools/AgentTool/agents/community-manager/references/opportunity-judgment.md` — 判断该不该回
4. `src/tools/AgentTool/agents/community-manager/references/engagement-playbook.md` — 回复模板/套路
5. `src/tools/AgentTool/agents/x-reply-writer/AGENT.md` + `references/x-reply-rules.md` — X reply 专用
6. `src/tools/AgentTool/agents/post-writer/AGENT.md` + `references/x-content-guide.md` + `references/reddit-content-guide.md` — 原创 post
7. `src/tools/AgentTool/agents/draft-review/references/review-checklist.md` + `x-review-rules.md` — 自审环节，需要新增 "arrogance check"
8. `src/references/platforms/x-strategy.md` — 共享平台策略

**改造方向 (待讨论):**
- **共情前置**: 强制 reply 第一句必须 mirror / 验证 OP 的处境 (不是 "Here's what to do" 而是 "Yeah this is the part nobody warns you about — …")
- **品牌植入降权**: post-writer 默认不提自家产品,只在原帖明确求推荐时才提;否则把"产品体验"转化为"个人经验" (从 "we built X" → "what we ended up doing was…")
- **Tone slider 真生效**: 现在 warmth=80 和 warmth=20 输出区别不大。在生成 prompt 里把 slider 转化成具体语言指令 (e.g. warmth=80 → "use first-person plural 'we', acknowledge feelings, end with a small encouragement")
- **Anti-pattern 列表**: 在 review-checklist 里新增 banned 短语集合 — "the right way to think about this", "what you really need is", "we built", "you should", "obviously", 一旦命中 → reject 重写
- **同侪语气样例库**: 在 references 里加一份 5-10 条优秀社区回复对照样本,让模型 few-shot 学习

**评估方式:**
- 选 20 条历史 thread 跑 A/B (旧 prompt vs 新 prompt),人工打分: empathy 0-10 / arrogance 0-10 / brand-pushiness 0-10
- 加自动化:在 `draft-review` 里加 "arrogance score" (LLM 自评),低于阈值打回重写
- Dogfood: 让真人 (尤其是非创始人语境的朋友) 盲读 10 条,选哪几条像"AI 写的"

**Owner / 时间:** 待定。建议 backend-engineer (prompt) + 1 个能写英文社区文案的人配合做样本评估。

---

# Product Backlog (scope / strategy)

### Stripe Payment Integration
- **What:** Stripe checkout for paid subscriptions.
- **Unblocks:** Settings › Billing tab, `/calendar` MONTHLY BUDGET KPI.
- **Depends on:** beta feedback + defined pricing tiers.

### Adaptive Health Score Engagement Baseline
- **What:** Replace hardcoded engagement baseline (20) in Health Score S3 with per-subreddit adaptive baselines from the user's own posting history.
- **Why:** norms vary wildly per community.
- **Depends on:** ~10+ posts per subreddit (2–3 weeks of active use).

### Weekly Marketing Digest Email
- **What:** Automated weekly summary email (performance, drafts, trends).
- **Why:** anti-churn.
- **Depends on:** email infra (Resend / Postmark).

### MCP Server Interface
- **What:** HTTP-transport MCP server exposing 4 tools: discover, drafts, approve, status.
- **Depends on:** stable API layer.

### Native X API v2 (replace xAI Grok search)
- **What:** X API v2 Basic tier for Discovery + Content + Posting.
- **Why:** Grok's `x_search` doesn't return `createdAt` (→ "1935d" hallucination), `likes`, `replies` (→ blank ↑/💬). Native API unlocks real timestamps + engagement metrics.
- **Cost:** ~$100/mo for Basic.
- **Depends on:** revenue justifying API cost.

### Stripe / Revenue Attribution
- **What:** Track which posts/channels drive revenue.
- **Depends on:** Stripe + mature analytics pipeline.

---

# Landing (low-priority copy fixtures)

Acceptable to leave as marketing copy indefinitely.

- Hero eyebrow "Live — 1,284 threads surfaced this week" (`hero-demo.tsx:60` + `threads-section.tsx:123`)
- `threads-section.tsx:14` `REAL_THREADS[]` — 3 curated thread+reply examples
- `safety-section.tsx:14` `REVIEW_CASES[]` — adversarial-review log examples
