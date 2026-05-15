import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads } from '@/lib/db/schema';
import { PLATFORMS } from '@/lib/platform-config';
import { HandoffClient } from './_components/handoff-client';

// Reddit thread URLs may surface from xAI Grok with non-canonical hosts. We
// allow all known commentable mirrors (canonical, old, new, np for "no
// participation", mobile). Media subdomains (i.redd.it / v.redd.it) are
// intentionally excluded — they are not commentable threads.
const ALLOWED_REDDIT_HOSTS = new Set([
  'www.reddit.com',
  'reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
]);

interface PageProps {
  params: Promise<{ draftId: string }>;
}

export default async function RedditHandoffPage({ params }: PageProps) {
  const { draftId } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    redirect(`/api/auth/signin?callbackUrl=/handoff/reddit/${draftId}`);
  }

  const draft = await db.query.drafts.findFirst({
    where: and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)),
  });

  if (!draft) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Draft not found</h1>
        <p className="mt-4 text-muted-foreground">
          This draft was deleted, or it belongs to a different account.
        </p>
        <a href="/today" className="mt-4 inline-block underline">
          ← Back to /today
        </a>
      </main>
    );
  }

  // Terminal-state guard. posted/failed/flagged bounce back to /today;
  // already-handed-off renders normally so re-visits stay idempotent.
  if (
    draft.status === 'posted' ||
    draft.status === 'failed' ||
    draft.status === 'flagged'
  ) {
    redirect(`/today?notice=draft_${draft.status}`);
  }

  if (draft.draftType !== 'reply') {
    redirect('/today?notice=not_a_reply_handoff');
  }

  const thread = await db.query.threads.findFirst({
    where: eq(threads.id, draft.threadId),
  });

  if (!thread) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Thread not found</h1>
        <p className="mt-4 text-muted-foreground">
          This thread was deleted from our records.{' '}
          <a href="/today" className="underline">
            Back to /today
          </a>
        </p>
      </main>
    );
  }

  if (thread.platform !== PLATFORMS.reddit.id) {
    redirect('/today?notice=not_a_reply_handoff');
  }

  // thread.url is stored relative ("/r/sub/comments/...") by the Reddit
  // persistence path, but older rows may carry an absolute URL. xAI Grok
  // is also in the write path, so we cannot trust the host on absolute
  // URLs — validate it before passing the value to window.open in the
  // client component.
  let absoluteUrl: URL;
  try {
    absoluteUrl = thread.url.startsWith('http')
      ? new URL(thread.url)
      : new URL(thread.url, 'https://www.reddit.com');
  } catch {
    redirect('/today?notice=invalid_thread_url');
  }
  if (!ALLOWED_REDDIT_HOSTS.has(absoluteUrl.host)) {
    redirect('/today?notice=invalid_thread_url');
  }
  const threadUrl = absoluteUrl.toString();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <HandoffClient
        draftId={draft.id}
        replyText={draft.replyBody}
        threadUrl={threadUrl}
        threadTitle={thread.title}
        subreddit={thread.community ?? ''}
        author={thread.author ?? ''}
        alreadyHandedOff={draft.status === 'handed_off'}
      />
    </main>
  );
}
