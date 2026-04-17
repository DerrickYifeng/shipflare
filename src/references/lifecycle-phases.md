# Product Lifecycle Phase Guide

The product has a `lifecyclePhase` field that is separate from the social-media growth phase (follower count). The lifecycle phase describes where the product itself is in its journey.

## Pre-Launch (`pre_launch`)

The product has not launched publicly yet. You are building, validating, and preparing.

**Content should focus on:**
- Problem/solution narrative: describe the pain point you're solving and why it matters
- Build-in-public teasers: share what you're working on without revealing everything
- Early validation signals: "talked to 20 founders, X% said they have this problem"
- Technical decisions: "why I chose X over Y for building Z"
- Progress updates: milestones hit, blockers overcome, lessons learned
- Audience questions: "would you use a tool that does X?"

**NEVER:**
- Mention user counts, signups, or active users (you have none yet)
- Share revenue or MRR figures
- Post user testimonials or quotes (you don't have users)
- Publish feature comparison charts against competitors
- Claim market traction or product-market fit
- Reference "our users" or "our customers"

## Launched (`launched`)

The product is live and has real users. You can reference concrete usage data.

**Content should focus on:**
- Metric updates: signups, active users, retention, conversion rates
- User testimonials and quotes (with permission)
- Feature highlights with real use cases from actual users
- User stories and mini case studies
- Lessons learned from launch: what worked, what didn't
- Behind-the-scenes: infrastructure decisions, scaling challenges
- Product updates: new features, improvements, bug fixes

**Allowed that was previously off-limits:**
- Real numbers (users, revenue, growth rate)
- User quotes and feedback
- Before/after comparisons with data

## Scaling (`scaling`)

The product has established traction and is growing. Content shifts to thought leadership.

**Content should focus on:**
- Growth milestones (MRR, user count, team size, funding)
- In-depth case studies with named customers (with permission)
- Thought leadership: insights from your domain expertise, backed by your data
- Industry analysis and trends you observe from your user base
- Hiring and team updates
- Technical deep-dives into architecture and scale challenges
- Community building and ecosystem development

## How to Use This in Content Generation

1. Read the `lifecyclePhase` field from the input
2. Apply the rules above as hard constraints (especially the NEVER rules for pre_launch)
3. Choose content angles that match the phase
4. When the calendar planner picks topics, it should weight content types by phase:
   - `pre_launch`: heavy on build-in-public (metric type), educational, engagement. Zero product-demo content.
   - `launched`: balanced mix. Product content now allowed and encouraged.
   - `scaling`: more thought leadership, case studies, industry analysis.
