"use client";

export function ReasoningPart({ text }: { text: string }) {
  return (
    <details
      data-testid="reasoning-part"
      open
      className="text-xs text-muted-foreground border-l-2 border-muted pl-2 my-1"
    >
      <summary className="cursor-pointer select-none">Thinking…</summary>
      <pre className="whitespace-pre-wrap font-mono text-xs mt-1">{text}</pre>
    </details>
  );
}
