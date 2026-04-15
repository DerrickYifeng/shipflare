# ShipFlare — Business Plan

## What It Is

An AI marketing autopilot for indie builders and one-person companies. ShipFlare finds where your users are talking online, drafts authentic replies, and posts them for you. It learns over time.

AI made building trivial. Marketing is the new bottleneck. ShipFlare fixes that.

---

## The Problem

Vibe coding changed who can build software. Designers, PMs, domain experts, students... anyone with an idea can ship a working product in a weekend using Cursor, Claude Code, Bolt, or Lovable. But none of these tools help you find users.

- Builders don't know how to market. They know how to build.
- Consistent engagement across Reddit, X, and HN is a full-time job.
- Fear of being spammy keeps builders silent.
- Relevant conversations are scattered across dozens of communities.

Existing tools (Buffer, Hootsuite, Syften) either schedule posts or send keyword alerts. None of them discover, draft, review, and post for you.

---

## How It Works

1. **Onboard** — Paste your URL or connect a GitHub repo. AI extracts your product profile.
2. **Discover** — Agents scan Reddit, X, and HN for relevant conversations.
3. **Draft** — AI writes value-first replies. Help first, mention product only when natural.
4. **Review** — 6-check quality gate (relevance, tone, authenticity, compliance, risk, value).
5. **Post** — User reviews and approves. Content goes live with rate limiting and shadowban detection.
6. **Learn** — Memory system improves per-product over time.

---

## Why Now

Vibe coding is the fastest-growing segment in software. The term didn't exist before February 2025 (coined by Andrej Karpathy). Collins Dictionary named it Word of the Year. Less than 18 months later, the tools are doing billions in revenue:

| Tool | Growth | Source |
|------|--------|--------|
| Cursor | $0 → $1B ARR in 24 months. Fastest SaaS company ever to $100M ARR. 1M+ daily active users, $29B valuation | SaaStr, Bloomberg |
| Lovable | $0 → $400M ARR in 15 months. 8M users, 100K+ new projects/day | TechCrunch, Sacra |
| Bolt.new | $0 → $20M ARR in 60 days. 5M signups in 5 months | Sacra, Emergence Capital |
| Replit | Revenue grew 24x in one year ($10M → $240M) after launching Agent. 40M users, pivoted to target non-programmers | TechCrunch |
| GitHub Copilot | 1M → 20M users in 21 months. 4.7M paid subscribers. 46% of all new code on GitHub is AI-generated | Microsoft earnings |

This explosion means millions of new products are being built by people who have never marketed anything. Every one of them is a potential ShipFlare user.

Other tailwinds:
- **One-person company boom.** 41M+ self-employed Americans (BLS). 35% of Carta startups are solo-founded, up from 30% in 2021. Stripe Atlas: 42% of new startups are AI companies, up from 15% in 2023.
- **Non-programmers are building.** Gartner: citizen developers will outnumber professional developers 4:1 by 2026. 80% of developers now use AI coding tools (Stack Overflow 2025).
- **LLM costs collapsed.** AI agent pipelines are economically viable at scale for the first time.

---

## Market

**Target customer:** Anyone who builds a product with AI tools but has no marketing process. Developers, designers, PMs, domain experts, students. The common thread: they can ship but can't market.

**TAM:** $18B social media marketing automation market (Grand View Research, 2024), growing at 17-20% CAGR, projected $47B+ by 2030.

**SAM:** The vibe coding ecosystem is growing exponentially. 35M+ people already use AI coding tools (Copilot 20M, Replit 40M, Cursor 1M+, Bolt 5M, Lovable 8M, v0 4M). Gartner projects citizen developers will outnumber professional developers 4:1 by 2026. Conservatively, 5M+ people will be actively building and shipping products with AI by end of 2026. If 10% try to market what they build, that's 500K potential users at $60/mo average = **$360M SAM**, growing fast.

**SOM (Year 1):** Vibe coding communities, indie hackers, OPCs. Target 10K users, 1K paid = ~$720K ARR.

---

## Business Model

### Cost Structure

Actual per-user costs based on our architecture (3 daily discovery runs, ~70 drafts/month):

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| AI providers (LLM inference) | ~$5.80 | Lightweight models for discovery/review, stronger models for content generation |
| Search APIs (platform search) | ~$2.00 | ~100 searches/month |
| Job queue (async processing) | ~$0.50 | Shared instance, per-user allocation |
| Database | ~$0.50 | Well within free/starter tier |
| **Total cost per user** | **~$8.80/mo** | |

### Pricing (based on cost + margin)

| Tier | Price | Margin | Target |
|------|-------|--------|--------|
| **Free** | $0/mo | — | 3 scans/week, view-only. Try before buy |
| **Starter** | $29/mo | ~70% | 1 product, Reddit only, 5 discovery runs/week |
| **Pro** | $79/mo | ~89% | All platforms, daily discovery, memory, auto-approve, X Growth Suite |
| **Team** | $199/mo | ~91% | 3 products, 5 seats, shared memory, priority agents |

Solopreneurs spend $200-500/month on marketing tools on average (HubSpot State of Marketing, 2024). ShipFlare replaces multiple tools at a fraction of that.

### Unit Economics

- Cost per user at scale (100+ users): ~$9-10/mo
- Blended ARPU (mix of tiers): ~$60/mo
- Gross margin: ~85%
- Target CAC: <$20 (organic-first)
- Expected LTV (18-month lifespan): ~$1,080
- LTV:CAC ratio: 50:1+

### What We Don't Know Yet

Conversion rate (free → paid), activation metric, and retention curve are unproven. Before building billing, we plan to validate willingness to pay with 50 users via manual Stripe links. The financial projections below assume we find product-market fit. If we don't, the numbers don't matter.

---

## Moat: Self-Evolving AI Agents

Anyone can build agents. The moat is **time-gated learning**.

ShipFlare runs a continuous loop: observe (log every run's results), distill (synthesize patterns into structured memory), apply (inject learning into future runs). The system on run 50 is measurably better than on run 1 — it knows which communities work for this product, what tone resonates, what gets removed by mods, and what the audience actually cares about.

A competitor can copy the architecture in weeks. They can't copy three months of per-product trial-and-error. A user switching to a competitor restarts from zero.

### Data Asset

Every pipeline run generates structured data at the intersection of product, audience, and community. At scale, this becomes a unique dataset:

- **ML-ready.** Train models on what actually works in indie product marketing — specific signals (product type × community × tone × timing → outcome) that no foundation model has.
- **Frontline startup intelligence.** Real-time view of what builders are shipping, what problems they're solving, which markets are heating up. For investors, a proprietary window into the startup ecosystem before it surfaces on ProductHunt or AngelList.
- **Compounds nonlinearly.** 100 users produce patterns. 10K produce a market map. 100K produce a dataset no one else can assemble.

### First-Mover

The vibe coding explosion created millions of new builders who have never marketed anything. Nobody is serving them yet. First-mover alone isn't permanent, but first-mover + data flywheel is: the earlier we acquire users, the more learning accumulates, the harder it is for a latecomer to match quality.

### Big AI Companies

They'll build horizontal platforms ("use Claude/GPT for anything"), not vertical community marketing tools. Subreddit rule engines, shadowban detection, per-community compliance — that's dirty work with no prestige. If they do enter: our data flywheel is already spinning, and acquisition is a valid exit.

---

## The Authenticity Question

ShipFlare generates content that gets posted to real communities. This is the hardest part of the business to get right, and we take it seriously.

**The concern is legitimate.** "Value-first, mention product only when natural" is the same language every spam tool uses. The difference has to be in the product's actual behavior, not the marketing copy.

**How we enforce it:**

1. **Human-in-the-loop by default.** Every draft requires user approval before posting. Auto-approve is an opt-in feature for experienced users, gated behind the Pro tier.
2. **6-check adversarial review.** Every draft passes relevance, value-first, tone match, authenticity, compliance, and risk checks before it's even shown to the user. The review agent is adversarial by design: its job is to reject, not to approve.
3. **Conservative rate limiting.** We post far below platform limits. A ShipFlare user will never flood a community with volume.
4. **Shadowban detection.** Every post is verified for visibility. If a post is silently removed, the system flags it and pauses posting to that community.

**What we don't do:** We don't pretend to be human. We don't post at scale to the same community. We don't bypass subreddit rules. We don't post where self-promotion isn't allowed.

**The existential risk:** A viral "ShipFlare is flooding our sub with AI replies" post would be devastating. We mitigate this by keeping volume low, quality high, and building a reputation in the communities we serve before we're discovered as an automation tool. But we're honest: this risk doesn't go to zero. It's the cost of operating in this space.

---

## Go-to-Market

**Phase 1** — Dogfood ShipFlare to market ShipFlare. Share results publicly.
**Phase 2** — Launch on ProductHunt, IndieHackers, HN. Free scans as viral hook.
**Phase 3** — Content and SEO. Case studies from real users.
**Phase 4** — Partner with vibe coding tools (Cursor, Claude Code marketplace) and indie dev communities.

Target blended CAC: <$20. Mostly organic.

---

## Roadmap

**Now:** Core pipeline is live. Reddit, X, HN. Memory system. X Growth Suite. Need billing (Stripe) and usage metering.

**Next:** LinkedIn, Discord, content repurposing, A/B testing drafts, close feedback loops (user rejections, post engagement, moderator removals feeding back into learning).

**Later:** Competitor tracking, multi-language, public API, white-label tier.

---

---

## Vision

Start with vibe coders and one-person companies... the people with the most acute pain, the most forgiving expectations, and the strongest word-of-mouth networks. Prove the model. Expand to startups, then SMBs. The underlying tech is a platform, not a feature.

---

*ShipFlare — AI Marketing Autopilot for Builders.*
