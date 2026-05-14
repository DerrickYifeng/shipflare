/**
 * `/chat` (list mode) — index of conversations.
 *
 * Sits alongside `app/(app)/chat/[conversationId]/page.tsx`. Next.js's
 * App Router matches the static `page.tsx` for `/chat` exactly and falls
 * through to the dynamic segment for `/chat/<id>` — no conflict.
 */

import ConversationList from "./_components/conversation-list";

export default function ChatListPage() {
  return (
    <div>
      <h1>Conversations</h1>
      <ConversationList />
    </div>
  );
}
