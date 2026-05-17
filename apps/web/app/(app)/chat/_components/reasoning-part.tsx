"use client";

export function ReasoningPart({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  // Auto-open while streaming so the user sees the reasoning live;
  // collapse once the part is finalized to keep the transcript clean.
  return (
    <details
      data-testid="reasoning-part"
      open={isStreaming}
      className="text-xs text-muted-foreground border-l-2 border-muted pl-2 my-1"
    >
      <summary className="cursor-pointer select-none">Thinking…</summary>
      <pre className="whitespace-pre-wrap font-mono text-xs mt-1">{text}</pre>
    </details>
  );
}
