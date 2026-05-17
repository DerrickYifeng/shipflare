"use client";

export function TextPart({ text }: { text: string }) {
  return (
    <div data-testid="text-part" className="text-base whitespace-pre-wrap">
      {text}
    </div>
  );
}
