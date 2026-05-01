export interface ReplyDraft {
  platform: "x";
  authorHandle: string;
  authorName: string;
  likes: number;
  postedRelative: string;
  threadBody: string;
  draftBody: string;
  confidence: number;
  charCap: number;
}

export interface PostDraft {
  platform: "x";
  contentType: string;
  scheduledAt: string;
  draftBody: string;
  charCap: number;
}

export interface ThreadHit {
  authorHandle: string;
  snippet: string;
  postedRelative: string;
}

/** Three live X conversations matched to the scanned product. */
export const HITS: ThreadHit[] = [
  {
    authorHandle: "@devjake",
    snippet:
      "our legacy PM tool is unbearable in 2026. spending 30% of my week on workflow setup, not shipping. anyone else?",
    postedRelative: "12m",
  },
  {
    authorHandle: "@founderpat",
    snippet:
      "best modern project tracker for a 5-person eng team? pricing on the old one keeps climbing.",
    postedRelative: "2h",
  },
  {
    authorHandle: "@itsmechelsea",
    snippet:
      "we just ditched our PM tool after 3 years. my eng team is happy again.",
    postedRelative: "1d",
  },
];

export const REPLY: ReplyDraft = {
  platform: "x",
  authorHandle: "@devjake",
  authorName: "Jake",
  likes: 234,
  postedRelative: "12m",
  threadBody:
    "our legacy PM tool is unbearable in 2026. spending 30% of my week on workflow setup, not shipping. anyone else? what are you using?",
  draftBody:
    "We switched 8 months ago. The shift wasn't features — it was the velocity calc on every cycle. Suddenly product can answer 'are we shipping?' without pinging me. Free for solo, scales linearly with seats.",
  confidence: 92,
  charCap: 280,
};

export const POST: PostDraft = {
  platform: "x",
  contentType: "Original",
  scheduledAt: "9:00 AM",
  draftBody:
    "Hot take: most early startups don't have a marketing problem. They have a 'no one knows you exist' problem. Solve discovery first, then talk about positioning. Shipping a thread on this tomorrow.",
  charCap: 280,
};
