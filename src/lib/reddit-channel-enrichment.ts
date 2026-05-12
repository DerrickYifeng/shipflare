/**
 * Deterministic enrichment helpers for Reddit subreddit kickoff research.
 *
 * The xAI research skill (see `researching-reddit-channels`) returns
 * LLM-guessed member counts; the team-kickoff worker calls these helpers
 * to overwrite with the real numbers from Reddit's public JSON API.
 *
 * Both helpers swallow errors and return null/zero fields so one bad
 * subreddit (404, rate-limited, malformed payload) does not kill the
 * whole batch.
 *
 * We call `https://www.reddit.com/.../.json` directly (matching
 * `REDDIT_PUBLIC_BASE` in `src/lib/reddit-client.ts`) rather than going
 * through `RedditClient.appOnly().get()` because that method is private.
 * Kickoff enrichment runs at most a handful of times per channel — well
 * below Reddit's anonymous IP-based limit — so we don't need the shared
 * rate-limit counter that gates the high-volume discovery loops.
 */

const REDDIT_PUBLIC_BASE = 'https://www.reddit.com';
const USER_AGENT = 'ShipFlare/1.0.0';
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const RECENT_POSTS_LIMIT = 50;

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${REDDIT_PUBLIC_BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Reddit GET ${path}: ${response.status}`);
  }
  return response.json();
}

export interface SubredditAbout {
  memberCount: number | null;
}

export async function fetchSubredditAbout(
  subreddit: string,
): Promise<SubredditAbout> {
  try {
    const data = (await fetchJson(`/r/${subreddit}/about.json`)) as {
      data?: { subscribers?: number } | null;
    };
    const subs = data?.data?.subscribers;
    return { memberCount: typeof subs === 'number' ? subs : null };
  } catch {
    return { memberCount: null };
  }
}

export interface SubredditActivity {
  postsLast7d: number;
  commentsLast7d: number;
  medianUpvotes: number;
}

interface RecentPost {
  created_utc: number;
  score: number;
  num_comments: number;
}

function isRecentPost(
  d: { created_utc?: number; score?: number; num_comments?: number } | undefined,
  cutoff: number,
): d is RecentPost {
  return (
    typeof d?.created_utc === 'number' &&
    d.created_utc >= cutoff &&
    typeof d.score === 'number' &&
    typeof d.num_comments === 'number'
  );
}

function median(sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 0;
  const n = sortedAsc.length;
  if (n % 2 === 1) {
    return sortedAsc[(n - 1) / 2]!;
  }
  return Math.round((sortedAsc[n / 2 - 1]! + sortedAsc[n / 2]!) / 2);
}

export async function fetchSubredditActivity(
  subreddit: string,
): Promise<SubredditActivity> {
  try {
    const data = (await fetchJson(
      `/r/${subreddit}/new.json?limit=${RECENT_POSTS_LIMIT}`,
    )) as {
      data?: {
        children?: Array<{
          data?: {
            created_utc?: number;
            score?: number;
            num_comments?: number;
          };
        }>;
      } | null;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - SEVEN_DAYS_SECONDS;
    const recent: RecentPost[] =
      data?.data?.children
        ?.map((c) => c.data)
        .filter((d): d is RecentPost => isRecentPost(d, cutoff)) ?? [];
    const postsLast7d = recent.length;
    const commentsLast7d = recent.reduce((sum, d) => sum + d.num_comments, 0);
    const scores = recent.map((d) => d.score).sort((a, b) => a - b);
    const medianUpvotes = median(scores);
    return { postsLast7d, commentsLast7d, medianUpvotes };
  } catch {
    return { postsLast7d: 0, commentsLast7d: 0, medianUpvotes: 0 };
  }
}
