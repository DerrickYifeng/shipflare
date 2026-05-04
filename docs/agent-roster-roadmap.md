# ShipFlare Agent Roster Roadmap

The full lineup of marketing agents we plan to ship — using **real industry job titles** so a founder reading the team page recognizes the role from any LinkedIn search. Organized by tier so the order of development reflects what a real startup CMO hires in what order.

Status legend:
- ✅ **Live** — agent exists and runs in production
- 🟡 **In flight** — partially built, needs refactor / rename
- 📋 **Planned** — on the public roadmap (landing page calls it out)
- 🔮 **Future** — strategic, not yet announced
- 🧩 **Vertical add-on** — only loaded when ICP demands it

---

## Tier 1 — Day-one essentials (founder + 1 hire equivalent)

### ✅ Chief Marketing Officer (CMO)

- **Real title:** Chief Marketing Officer / VP Marketing
- **Maps to today:** `coordinator` agent
- **Job:** Receives founder goals, decomposes, delegates to specialists, synthesizes results into a weekly brief. Owns the strategic path doc and the founder's marketing chief-of-staff role.
- **Tools:** `Task`, `SendMessage`, `query_plan_items`, `query_strategic_path`, `generate_strategic_path`, `add_plan_item`, `update_plan_item`, `StructuredOutput`
- **Skills:** none (purely orchestrating; no fork work of its own)

### ✅ Social Media Manager

- **Real title:** Social Media Manager / Senior Social Media Manager
- **Maps to today:** `social-media-manager` agent (collapsed `discovery-agent` + `content-manager` + parts of `content-planner` — Plans 1–3 shipped 2026-05-04)
- **Job:** Owns the entire X (and later LinkedIn / Reddit / HN / Discord) presence. Finds threads to engage with, drafts replies, drafts + schedules original posts, maintains brand voice across all channels.
- **Tools (orchestration — own the pipelines internally):**
  - `find_threads_via_xai` — Tool whose execute() runs the multi-turn xAI conversation loop + per-candidate judging + persistence
  - `process_replies_batch` — Tool whose execute() runs draft → validate → persist with REVISE retry, for N threads
  - `process_posts_batch` — Tool whose execute() does the same for N plan_items
  - These three tools are the **single source of truth** for the reply/post pipelines — pipeline prose no longer lives in any AGENT.md.
- **Tools (read / atomic):** `find_threads`, `x_post`, `x_reply`, `reddit_post`, `reddit_reply`, `draft_reply`, `draft_post`, `query_plan_items`, `SendMessage`, `StructuredOutput`
- **Fork-skills (LLM judgment, called from inside the orchestration tools):**
  - `drafting-reply` / `drafting-post` — single-item drafters
  - `validating-draft` — fresh-context review (separate fork per primitive boundary)
  - `judging-thread-quality` — used inside `find_threads_via_xai`
- **Multi-platform strategy:** ONE agent, references vary by `channel` parameter (`x-voice-direction.md`, `reddit-voice-direction.md`, etc.). Tools namespaced by platform (`x_post`, `reddit_post`). The orchestration tools delegate to the right `channel` reference based on each item's row.

---

## Tier 2 — Early startup full kit (already on landing page roadmap)

### 📋 Product Marketing Manager (PMM)

- **Real title:** Product Marketing Manager / Senior PMM / Technical PMM (if dev tools)
- **Job:** Positioning, messaging, launch briefs, competitive intel, wedge story refinement, sales enablement copy, keep all other agents on-message.
- **Tools:** `query_product_context`, `query_competitor_intel`, `persist_positioning_doc`, `persist_launch_brief`, `query_recent_launches`, `query_pricing_history`
- **Skills:**
  - `drafting-launch-brief` (fork)
  - `drafting-positioning-doc` (fork)
  - `validating-positioning-claim` (fork — separate from drafting per primitive boundary)
  - `analyzing-competitor-activity` (fork or bundled)
  - `refreshing-wedge-doc` (fork)
  - `auditing-cross-channel-messaging` (bundled — pulls from other agents' recent output, checks consistency)
- **Why first in Tier 2:** Without PMM the CMO is overloaded doing positioning by hand. Highest leverage hire after the first social hire.

### 📋 SEO Manager

- **Real title:** SEO Manager / Technical SEO Specialist (sometimes "Search Marketing Manager")
- **Maps to landing page:** SEARCH (SEO + GEO unified)
- **Job:** Organic search rankings (Google), generative engine optimization (LLM citations), keyword strategy, technical SEO audits, internal linking, backlink monitoring, `llms.txt` maintenance.
- **Tools:** `query_seo_rankings`, `query_backlinks`, `query_search_console`, `persist_keyword_strategy`, `persist_llms_txt`, `audit_page_seo`
- **Skills:**
  - `analyzing-keyword-opportunity` (fork)
  - `drafting-seo-brief` (fork)
  - `drafting-llms-txt` (fork)
  - `auditing-page-seo` (bundled — runs structured checks against a URL)
  - `analyzing-citation-opportunity` (fork — for GEO)

### 📋 Performance Marketing Manager

- **Real title:** Performance Marketing Manager (B2B SaaS) / Demand Generation Manager (enterprise B2B)
- **Maps to landing page:** PERFORMANCE
- **Job:** Paid media management — Meta Ads, Google Ads, X Ads, LinkedIn Ads, TikTok Ads, Reddit Ads. Audience targeting, creative iteration, ROAS / CAC / pipeline tracking, budget allocation.
- **Tools:** `query_ad_performance`, `query_audience_segments`, `persist_campaign_brief`, `persist_audience_definition`, `query_ad_spend`
- **Skills:**
  - `drafting-ad-creative` (fork)
  - `drafting-campaign-brief` (fork)
  - `analyzing-campaign-performance` (fork or bundled)
  - `drafting-audience-targeting` (fork)
  - `analyzing-creative-fatigue` (bundled)

### 📋 Content Marketing Manager

- **Real title:** Content Marketing Manager / Editor (when senior)
- **Maps to landing page:** CONTENT
- **Job:** Long-form content production — blog posts, ebooks, newsletters, changelogs, video scripts, podcast outlines. Editorial calendar. SEO-aware briefs (works WITH SEO Manager).
- **Tools:** `query_content_calendar`, `persist_blog_post`, `persist_newsletter_issue`, `persist_changelog`, `query_published_content`
- **Skills:**
  - `drafting-blog-post` (fork — long-form, multi-section)
  - `drafting-newsletter-issue` (fork)
  - `drafting-changelog` (fork)
  - `drafting-content-brief` (fork — outlines for human-written pieces)
  - `validating-blog-post` (fork — separate review per primitive boundary)

### 📋 Marketing Analytics Manager

- **Real title:** Marketing Analytics Manager / Marketing Operations Analyst
- **Maps to landing page:** ANALYTICS
- **Job:** Funnel reporting, multi-touch attribution, dashboards, experiment design, weekly metrics review for the CMO's brief.
- **Tools:** `query_funnel_metrics`, `query_experiment_results`, `query_attribution_paths`, `persist_weekly_report`, `persist_ab_test_definition`
- **Skills:**
  - `composing-weekly-metrics-brief` (bundled — pulls from multiple data sources)
  - `analyzing-funnel-drop` (fork)
  - `designing-ab-test` (fork)
  - `interpreting-attribution-shift` (fork)

---

## Tier 3 — Scale-up additions (the "feels like a real org" tier)

### 🔮 Lifecycle Marketing Manager

- **Real title:** Lifecycle Marketing Manager / CRM Marketing Manager / Email Marketing Manager
- **Job:** Onboarding email sequences, retention campaigns, expansion campaigns, churn save flows, NPS surveys, in-app messaging, customer journey design across email + push + in-app.
- **Tools:** `send_email`, `send_push`, `query_user_cohorts`, `query_churn_signals`, `persist_email_sequence`, `query_lifecycle_funnel`
- **Skills:**
  - `drafting-onboarding-sequence` (bundled — multi-email sequence, deterministic structure)
  - `drafting-winback-email` (fork)
  - `drafting-expansion-email` (fork)
  - `analyzing-activation-funnel` (fork)
  - `designing-lifecycle-journey` (fork)

### 🔮 Brand & Communications Manager

- **Real title:** Brand Manager / Communications Manager / PR Manager (often combined at this stage)
- **Job:** Press releases, founder thought leadership (LinkedIn ghostwriting, X long-posts in founder's voice), Hacker News launches, ProductHunt launches, crisis comms templates, brand voice consistency, exec ghostwriting.
- **Tools:** `query_press_history`, `persist_press_release`, `query_exec_voice_corpus`, `query_launch_calendar`
- **Skills:**
  - `drafting-press-release` (fork)
  - `ghostwriting-exec-post` (fork — uses exec_voice_corpus to imitate founder's voice)
  - `drafting-launch-comms` (bundled — coordinates HN + PH + X + email simultaneously)
  - `drafting-crisis-statement` (fork)
  - `auditing-brand-voice` (bundled — scans recent output across agents for off-brand drift)

### 🔮 Customer Marketing Manager

- **Real title:** Customer Marketing Manager / Customer Advocacy Manager
- **Job:** Case study production, reference customer programs, advocacy / referral programs, community spotlights, customer feedback synthesis, expansion campaigns.
- **Tools:** `query_top_customers`, `persist_case_study`, `query_customer_feedback`, `persist_advocacy_program`
- **Skills:**
  - `drafting-case-study` (fork)
  - `drafting-reference-ask` (fork — outreach to a happy customer)
  - `analyzing-customer-feedback` (fork)
  - `drafting-customer-spotlight` (fork)

---

## Tier 4 — Vertical add-ons (load when ICP demands)

These agents only spawn when the founder's onboarding flags signal the relevant business type.

### 🧩 User Acquisition Manager

- **When to add:** founder's product is a mobile app or has primarily paid-driven growth.
- **Real title:** User Acquisition Manager / UA Manager
- **Job:** Mobile-specific paid acquisition — Apple Search Ads, Google App Campaigns, TikTok For Business, Meta App Install Ads. AppsFlyer / Adjust / Singular attribution. CPI / LTV / ROAS optimization. Creative testing.
- **Tools:** `query_ua_metrics`, `query_install_attribution`, `persist_creative_test`, `query_ltv_by_cohort`
- **Skills:**
  - `drafting-ua-creative-brief` (fork)
  - `analyzing-ua-creative-performance` (fork or bundled)
  - `analyzing-ltv-cohort` (fork)
  - `optimizing-ua-bid` (bundled)

### 🧩 ASO Manager

- **When to add:** founder's product is on App Store / Play Store.
- **Real title:** ASO Manager / App Store Optimization Specialist
- **Job:** App Store / Play Store ranking — title/subtitle/keywords, screenshot tests, icon tests, review reply automation, localized listings.
- **Tools:** `query_aso_rankings`, `persist_aso_listing`, `persist_screenshot_test`, `query_app_reviews`
- **Skills:**
  - `drafting-app-listing` (fork)
  - `analyzing-aso-keywords` (fork)
  - `drafting-review-reply` (fork)

### 🧩 Creative Strategist

- **When to add:** paid acquisition spend is significant (typically >$10K/mo) — UA-heavy verticals.
- **Real title:** Creative Strategist / Creative Director (senior)
- **Job:** Strategy for paid ad creative production. Concept ideation, hook testing, creative fatigue monitoring, brief writing for designers / video producers.
- **Tools:** `query_creative_performance`, `persist_creative_brief`, `query_creative_fatigue_signals`
- **Skills:**
  - `drafting-creative-brief` (fork)
  - `analyzing-creative-fatigue` (bundled)
  - `ideating-creative-concepts` (fork)

### 🧩 Influencer Marketing Manager

- **When to add:** B2C brand with influencer-fit ICP (DTC / consumer / gaming).
- **Real title:** Influencer Marketing Manager / Creator Partnerships Manager
- **Job:** Influencer / creator outreach, partnership negotiation, campaign management, brand fit screening, performance tracking.
- **Tools:** `query_creator_database`, `persist_outreach`, `query_creator_performance`, `persist_partnership_terms`
- **Skills:**
  - `drafting-creator-pitch` (fork)
  - `analyzing-influencer-fit` (fork)
  - `drafting-campaign-brief-for-creator` (fork)

### 🧩 Conversion Rate Optimization (CRO) Specialist

- **When to add:** clear conversion-rate problem with steady traffic (typically e-commerce / SaaS landing pages).
- **Real title:** Conversion Rate Optimization Specialist / Web Marketing Manager
- **Job:** Landing page conversion optimization, funnel A/B tests, copy/design test design, hypothesis-driven experimentation.
- **Tools:** `query_landing_page_metrics`, `persist_ab_test`, `query_session_recordings`, `persist_funnel_hypothesis`
- **Skills:**
  - `designing-landing-page-test` (fork)
  - `analyzing-conversion-funnel` (fork)
  - `drafting-cro-hypothesis` (fork)

### 🧩 Developer Advocate

- **When to add:** founder's product is a developer tool / API / SaaS for engineers.
- **Real title:** Developer Advocate / DevRel Engineer / Developer Marketing Manager
- **Job:** Developer community engagement, technical content (tutorials, sample apps, docs that read like marketing), conference CFPs, dev meetup speaking, GitHub presence.
- **Tools:** `query_developer_community`, `persist_tutorial_post`, `query_github_engagement`, `persist_cfp_submission`
- **Skills:**
  - `drafting-tutorial-post` (fork)
  - `drafting-conference-cfp` (fork)
  - `analyzing-dev-community-pulse` (fork)
  - `drafting-sample-app-readme` (fork)

### 🧩 Community Manager

- **When to add:** founder's product has user-led communities (Discord / Slack / Reddit / forums) — distinct from owned social channels.
- **Real title:** Community Manager / Community Lead
- **Note:** This is **different** from Social Media Manager. Community Manager owns user-led spaces (Discord, Slack groups, subreddits, forums). Social Media Manager owns owned channels (X, LinkedIn, IG).
- **Job:** Community moderation, AMA coordination, user spotlights, advocacy programs, community events, member recognition.
- **Tools:** `send_discord_message`, `query_community_pulse`, `persist_community_event`, `query_community_members`
- **Skills:**
  - `drafting-community-post` (fork)
  - `moderating-discussion` (fork)
  - `drafting-ama-prep` (fork)
  - `drafting-member-spotlight` (fork)

---

## Development order (recommended)

The first 5 plans below are concrete plan-doc-worthy bodies of work. After Plan 5, vertical add-ons load on demand based on ICP.

| # | Plan | Tier | What it ships |
|---|---|---|---|
| 1 | ✅ Merge judging-opportunity into judging-thread-quality + share slop-rules.md | Tier 1 prep | Shipped 2026-05-03. Plan: `docs/superpowers/plans/2026-05-03-merge-judging-and-share-slop-rules.md` |
| 2 | ✅ Convert content-manager pipelines into orchestration **tools** (`process_replies_batch`, `process_posts_batch`, `find_threads_via_xai`) | Tier 1 prep | Shipped 2026-05-04. Pipelines moved out of AGENT.md into `ProcessRepliesBatchTool`, `ProcessPostsBatchTool`, `FindThreadsViaXaiTool` — these are now the SSOT for the reply/post pipelines. |
| 3 | ✅ Collapse `discovery-agent` + `content-manager` + `content-planner` → **Social Media Manager** agent. Renamed in DB + UI + landing page. | Tier 1 finish | Shipped 2026-05-04. Real-title roster begins. CMO regains strategy headspace. Tier 1 complete. |
| 4 | Add **Product Marketing Manager (PMM)** agent | Tier 2 start | First Tier-2 specialist. Highest leverage. |
| 5 | Add **SEO Manager** agent | Tier 2 | Aligns with landing page SEARCH promise. |
| 6 | Add **Performance Marketing Manager** | Tier 2 | Aligns with PERFORMANCE promise. |
| 7 | Add **Content Marketing Manager** | Tier 2 | Aligns with CONTENT promise. |
| 8 | Add **Marketing Analytics Manager** | Tier 2 | Aligns with ANALYTICS promise. Tier 2 complete. |
| 9 | Add **Lifecycle Marketing Manager** | Tier 3 | First Tier-3 — fills the retention/expansion gap. |
| 10 | Add **Brand & Communications Manager** | Tier 3 | Press, exec voice, launch comms. |
| 11 | Add **Customer Marketing Manager** | Tier 3 | Case studies, advocacy. Tier 3 complete = "feels like a real org." |
| 12+ | Vertical add-ons load on demand from onboarding flags | Tier 4 | UA / ASO / Creative / Influencer / CRO / DevRel / Community |

---

## Architectural rules every agent follows

(Per CLAUDE.md `## Primitive Boundaries — Tool / Skill / Agent`.)

1. **AGENT.md is identity + tools + skills, not a pipeline.** No embedded "step 1 → step 2 → step 3" scripts. Pipelines live in bundled (TS) skills.
2. **Each rule has exactly one owner.** Slop rules in `src/references/slop-rules.md`, voice direction in per-platform reference files, etc. Cross-link, never copy.
3. **Drafting and validating run in different fork calls.** A drafter never self-validates.
4. **When in doubt, default to skill.** A multi-turn agent is justified only when the loop itself is the work — research / decomposition / cross-channel allocation with feedback signals.
5. **Each agent is a domain expert** with a curated set of tools and skills. Generalists do not exist on this roster.

---

## Open product questions

These are decisions that affect the roster but aren't engineering work yet:

- **ICP-based agent loadout** — onboarding identifies business type (B2B SaaS / dev tools / mobile app / DTC / consumer web) and activates the right Tier 4 add-ons. Need the onboarding flag schema. Default loadout = B2B SaaS unless onboarding says otherwise.
- **Weekly digest** — once Tier 2+ ships, the founder can't process 6+ agents independently. CMO must compose a weekly brief that synthesizes everyone's output. Hidden requirement that ships alongside Tier 2.
- **Roster page UX** — landing page `HowItWorks` shows 6 cards today. With 9-15 agents, need a different layout. Either tabs by tier, or a horizontal scroll, or a "your active team" filter based on onboarding ICP.
- **Naming on landing page** — current "SOCIAL", "CONTENT" all-caps tags read as feature names, not job titles. Switch to title case ("Social Media Manager", "Content Marketing Manager") so visitors recognize the role.
