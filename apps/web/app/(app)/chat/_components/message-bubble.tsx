"use client";

import type { PropsWithChildren } from "react";

type MessageRole = "user" | "assistant" | "system";

const roleClasses: Record<MessageRole, string> = {
  user: "bg-primary/10",
  assistant: "bg-muted",
  system: "bg-muted/50 border border-dashed border-muted-foreground/30",
};

export function MessageBubble({
  role,
  children,
}: PropsWithChildren<{ role: MessageRole }>) {
  return (
    <div
      data-testid="message-bubble"
      data-role={role}
      className={`my-2 p-3 rounded ${roleClasses[role]}`}
    >
      {children}
    </div>
  );
}
