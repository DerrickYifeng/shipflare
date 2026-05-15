/**
 * `/chat/[conversationId]` — founder chat with the CMO.
 *
 * Phase 1 keeps this dead simple: a server component that just hands the
 * conversationId to the client streaming component. History loading happens
 * client-side on mount once the MCP client is connected.
 *
 * Phase 2 may server-prefetch the conversation transcript so the first paint
 * already includes prior turns. For now the connection-on-mount UX is good
 * enough and avoids a duplicate code path (browser already needs the MCP
 * client live for the next message).
 */

import ChatStream from "../_components/chat-stream";

interface ChatPageProps {
  params: Promise<{ conversationId: string }>;
}

export default async function ChatPage({ params }: ChatPageProps) {
  const { conversationId } = await params;
  return (
    <div>
      <h1>Chat with CMO</h1>
      <p style={{ color: "#888", fontSize: "0.875rem" }}>
        Conversation: <code>{conversationId}</code>
      </p>
      <ChatStream conversationId={conversationId} />
    </div>
  );
}
