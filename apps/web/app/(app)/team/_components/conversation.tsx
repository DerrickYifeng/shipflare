"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { TeamActivityMessage } from "@/hooks/use-team-events";
import { LeadMessage } from "./lead-message";
import { UserMessage } from "./user-message";
import { EmptyConversation } from "./empty-conversation";
import { TypingIndicator } from "./typing-indicator";

interface ConversationProps {
  messages: TeamActivityMessage[];
  onPromptSelect?: (prompt: string) => void;
  /**
   * Optional slot rendered immediately after each assistant (CMO / lead)
   * message bubble. Used by `TeamDesk` to inject an `<ActivityTrail>`
   * scoped to the turn's `parentTurnId`. Returning `null` skips injection
   * for that message (older messages without a `parentTurnId`).
   */
  renderMessageExtras?: (msg: TeamActivityMessage) => ReactNode;
}

const SCROLL_CONTAINER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "16px 20px",
};

export function Conversation({
  messages,
  onPromptSelect,
  renderMessageExtras,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or the last message
  // grows (streaming chunks landing).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content?.length]);

  if (messages.length === 0) {
    return <EmptyConversation onPromptSelect={onPromptSelect} />;
  }

  // Determine if the trailing message is a CMO turn still streaming
  // with no content yet — that's when we show the typing dots instead
  // of an empty bubble.
  const last = messages[messages.length - 1];
  const showTyping =
    !!last &&
    last.type === "agent_text" &&
    (last.content?.length ?? 0) === 0 &&
    last.metadata?.streaming === true;

  return (
    <div
      style={SCROLL_CONTAINER}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
    >
      {messages.map((msg) => {
        const isUser = msg.type === "user_prompt";
        const isError = msg.type === "error";
        const isStreaming = msg.metadata?.streaming === true;

        if (isUser) {
          return (
            <UserMessage
              key={msg.id}
              content={msg.content ?? ""}
              createdAt={msg.createdAt}
            />
          );
        }

        // Skip the empty placeholder when we're rendering the typing
        // indicator below it.
        if (
          showTyping &&
          msg === last &&
          (msg.content?.length ?? 0) === 0
        ) {
          return null;
        }

        const extras = renderMessageExtras?.(msg);
        return (
          <div key={msg.id}>
            <LeadMessage
              from={msg.from ?? "cmo"}
              content={msg.content ?? ""}
              createdAt={msg.createdAt}
              streaming={isStreaming}
              isError={isError}
            />
            {extras}
          </div>
        );
      })}
      {showTyping && <TypingIndicator role={last.from ?? "cmo"} />}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
