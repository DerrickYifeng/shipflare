// Copy strings locked per frontend spec §13.
// Single module so future i18n is a one-file diff.

export type StepIndex = 0 | 1 | 2 | 3;

export interface RailStep {
  readonly label: string;
  readonly detail: string;
}

export const COPY = {
  rail: {
    header: 'ShipFlare',
    meta: (step: number) => `Setup · ${step + 1} of 4`,
    steps: [
      {
        label: 'Add your product',
        detail:
          "We'll scan your repo or site to extract name, description, and keywords.",
      },
      {
        label: 'Connect your accounts',
        detail:
          'So ShipFlare can draft replies and schedule posts on your behalf.',
      },
      {
        label: "Where's your product at?",
        detail:
          'This decides whether we generate a pre-launch playbook or a compound plan.',
      },
      {
        label: 'Your launch plan',
        detail:
          'Your calibrated plan — product, timeline, and first-week tasks.',
      },
    ] as readonly RailStep[],
    footerStatus: '6 agents ready',
  },
  stage1: {
    kicker: 'Step 1 · Source',
    title: 'Add your product',
    sub: "We'll scan your product to extract name, description, and keywords automatically.",
    methodGithub: {
      title: 'Import from GitHub',
      sub: 'Scan your code to understand your product.',
    },
    methodUrl: {
      title: 'From website URL',
      sub: "We'll scan your homepage for details.",
    },
    orManual: 'or enter manually →',
    pickDifferent: 'Pick a different method',
    urlLabel: 'Product URL',
    urlHint: "We'll scan your page and extract product details automatically.",
    urlPlaceholder: 'https://your-product.com',
    scanRepo: 'Scan repository',
    scanUrl: 'Scan website',
    fallbackLink: 'Continue with just this URL →',
    urlError: 'Paste a URL to continue.',
    extractError:
      "We couldn't reach that page. Check the URL, or continue with just the URL.",
    repoError: "Couldn't read this repo. Check access and try again, or switch to URL.",
    github: {
      title: 'Authorize GitHub',
      sub: 'Read-only access to repo metadata, READMEs, and release notes. We never clone code or write to your repos.',
      button: 'Authorize ShipFlare',
      connectingButton: 'Authorizing…',
      searchPlaceholder: 'Search repositories…',
    },
  },
  stage2: {
    kicker: 'Step 1 · Scanning',
    title: 'Reading',
    sub: "Six agents are extracting your profile. You'll see everything before it's saved.",
    footer: 'Discovery only · nothing is posted until you approve',
    cancel: 'Cancel',
    agentName: 'Scout',
    stepsGithub: [
      { id: 'readme',   label: 'Reading README',              target: 'repo root · install · features' },
      { id: 'pkg',      label: 'Parsing package metadata',    target: 'package.json · description · keywords' },
      { id: 'releases', label: 'Scanning recent releases',    target: 'last 10 release notes · commits' },
      { id: 'audience', label: 'Inferring audience',          target: 'developers · indie founders' },
      { id: 'keywords', label: 'Compiling keyword shortlist', target: '12 phrases for Reddit + X' },
    ],
    stepsUrl: [
      { id: 'readme',   label: 'Reading your homepage',       target: 'hero · meta · copy' },
      { id: 'pkg',      label: 'Parsing meta + OG tags',      target: 'title · description · image' },
      { id: 'releases', label: 'Scanning landing copy',       target: 'features · value prop · CTA' },
      { id: 'audience', label: 'Inferring audience',          target: 'developers · indie founders' },
      { id: 'keywords', label: 'Compiling keyword shortlist', target: '12 phrases for Reddit + X' },
    ],
  },
  stage3: {
    kicker: 'Step 1 · Review',
    title: "Here's what we found",
    subPrefix:
      "Edit anything that's off — this is what your AI team will use to find conversations and write replies.",
    extractedFrom: 'Extracted from',
    fields: {
      name: { label: 'Product name', hint: 'How users refer to it.' },
      description: {
        label: 'What it does',
        hint: 'One or two sentences. Used to evaluate thread relevance.',
      },
      audience: {
        label: 'Target audience',
        hint: "Who you're trying to reach.",
      },
      keywords: {
        label: 'Keywords',
        hint: 'Search terms for scanning Reddit, X, and HN.',
      },
      category: {
        label: 'Product category',
        hint: 'Picks the playbook ShipFlare uses — different categories get different launch plans.',
      },
    },
    categoryOptions: [
      { id: 'dev_tool', label: 'Dev tool' },
      { id: 'saas', label: 'SaaS' },
      { id: 'consumer', label: 'Consumer app' },
      { id: 'creator_tool', label: 'Creator tool' },
      { id: 'agency', label: 'Agency / services' },
      { id: 'ai_app', label: 'AI app' },
      { id: 'other', label: 'Something else' },
    ] as const,
    keywordAddPlaceholder: 'Add keywords…',
    keywordAddMorePlaceholder: 'Add more…',
    whatHappensNext: 'What happens next:',
    whatHappensNextDetail:
      " We'll use this to search communities every few hours. Nothing posts until you approve each draft.",
    continueCta: 'Looks good, continue',
  },
  stage4: {
    kicker: 'Step 2 · Channels',
    title: 'Connect your accounts',
    sub: 'We post as you, but only with your approval. Connect at least one to enable the agents.',
    cards: {
      reddit: {
        title: 'Reddit',
        desc: 'Posts, comments, and subreddit discovery',
        sample: 'r/SaaS, r/indiehackers, r/nextjs',
      },
      x: {
        title: 'X',
        desc: 'Replies, quote-posts, and thread discovery',
        sample: '#buildinpublic, @levelsio network',
      },
    },
    infoTitle: 'You approve every post.',
    infoDetail:
      ' ShipFlare drafts replies based on your profile, then queues them in /today for your review. Nothing goes live until you tap Send.',
    backCta: 'Back',
    skipCta: 'Skip for now',
    nextCta: "Next · Where's your product at?",
    errorX: "Couldn't reach X. This usually clears in a minute.",
    errorReddit: "Couldn't reach Reddit. Retry in a moment.",
    comingSoon: 'Coming soon',
    comingSoonTooltip: 'Reddit drafting is coming soon',
  },
  stage5: {
    kicker: 'Step 3 · State',
    title: "Where's your product at?",
    sub: 'This decides the shape of your plan — a pre-launch playbook, a launch-week sprint, or compound growth.',
    generateCta: 'Generate plan',
    options: [
      {
        id: 'mvp',
        kicker: 'MVP · pre-launch',
        title: "I'm still building.",
        sub: 'No public launch yet. You have a prototype, alpha users, or a closed beta.',
        plan: 'Pre-launch playbook',
        planDetail: 'Audience research, Show HN prep, first 100 users.',
      },
      {
        id: 'launching',
        kicker: 'Launching this week',
        title: "I'm launching soon.",
        sub: 'Product Hunt, Show HN, or a public beta in the next 7–14 days.',
        plan: 'Launch-week sprint',
        planDetail:
          'Coordinated posts across Reddit, HN, and X — timed to your launch.',
        recommended: true,
      },
      {
        id: 'launched',
        kicker: 'Launched · growing',
        title: "I'm already live.",
        sub: 'You have real users and want to compound organic reach.',
        plan: 'Compound growth plan',
        planDetail: 'Ongoing scans, weekly quota, and reply-to-ratio tuning.',
      },
    ] as const,
    launchDetailsTitle: 'Launch details',
    usersTitle: 'Roughly how many users?',
    channels: [
      { id: 'producthunt', label: 'Product Hunt' },
      { id: 'showhn', label: 'Show HN' },
      { id: 'both', label: 'Both' },
      { id: 'other', label: 'Other / self' },
    ] as const,
    userBuckets: ['<100', '100-1k', '1k-10k', '10k+'] as const,
    recommendedBadge: 'Most popular',
  },
  stage6: {
    kicker: 'Step 4 · Building plan',
    title: 'AI is calibrating your plan',
    subPrefix: 'Our agents are shaping a plan around your',
    subSuffix: 'product.',
    durationHint: '≈ 30s',
    durationCaption: 'sit tight — six checks running in parallel',
    agentName: 'Analyst',
    timeoutMessage: 'This is taking longer than expected.',
    retryCta: 'Retry',
    fallbackCta: 'Continue with manual plan',
    steps: [
      { id: 'load',     label: 'Loading profile',              target: 'name · description · keywords' },
      { id: 'match',    label: 'Matching state to plan shape', target: '{STATE} · compound · sprint · playbook' },
      { id: 'channels', label: 'Calibrating channels',         target: 'Reddit · X · reply-to-ratio' },
      { id: 'subs',     label: 'Shortlisting subreddits',      target: 'relevance · activity · moderation' },
      { id: 'cadence',  label: 'Planning first-week cadence',  target: 'replies · posts · approval gate' },
      { id: 'review',   label: 'Adversarial QA on the plan',   target: 'check tone · safety · quotas' },
    ],
  },
  stage7: {
    kicker: 'Step 4 · Plan',
    title: 'Your launch plan',
    subSuffix:
      ' You can edit anything — this is a starting point, not a contract.',
    tabs: [
      { id: 'about', label: 'A · About your product' },
      { id: 'timeline', label: 'B · Timeline' },
    ] as const,
    aboutLabels: {
      name: 'Name',
      description: 'Description',
      audience: 'Audience',
      keywords: 'Keywords',
      channels: 'Channels',
    },
    keywordsMeta: 'extracted · editable',
    addKeyword: '+ Add',
    quota: 'Quota',
    pending: 'pending',
    launchCta: 'Launch the agents',
    meetYourTeam: {
      heading: 'Meet your team',
      sub: "Your team is ready to launch. They'll start working the moment you approve your first plan.",
      previewNote:
        "These roles will be ready after you ship your first plan.",
    },
  },
} as const;
