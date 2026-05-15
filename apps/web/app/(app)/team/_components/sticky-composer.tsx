"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

interface StickyComposerProps {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  placeholder?: string;
}

const COMPOSER_WRAP: CSSProperties = {
  padding: "12px 20px 16px",
  background: "var(--sf-bg-secondary)",
  borderTop: "1px solid var(--sf-border-subtle)",
  flexShrink: 0,
};

const INNER: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 10,
  background: "var(--sf-bg-primary)",
  borderRadius: "var(--sf-radius-xl)",
  padding: "8px 8px 8px 16px",
  border: "1px solid var(--sf-border)",
};

const TEXTAREA: CSSProperties = {
  flex: 1,
  resize: "none",
  border: "none",
  background: "transparent",
  fontFamily: "var(--sf-font-text)",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--sf-fg-1)",
  outline: "none",
  padding: 0,
  minHeight: 20,
  maxHeight: 160,
  overflowY: "auto",
};

const SEND_BTN: CSSProperties = {
  flexShrink: 0,
  width: 32,
  height: 32,
  borderRadius: "var(--sf-radius-md)",
  background: "var(--sf-accent)",
  color: "var(--sf-fg-on-dark-1)",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  transition: `opacity var(--sf-dur-fast) var(--sf-ease), background var(--sf-dur-fast) var(--sf-ease)`,
};

const SEND_BTN_DISABLED: CSSProperties = {
  ...SEND_BTN,
  opacity: 0.4,
  cursor: "not-allowed",
};

export function StickyComposer({
  onSend,
  disabled,
  placeholder = "Message your team…",
}: StickyComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = draft.trim().length > 0 && !disabled && !sending;

  // Auto-grow the textarea.
  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    setSending(true);
    setDraft("");
    // Reset textarea height.
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    try {
      await onSend(text);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [draft, disabled, sending, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter or Enter-only (not shift) sends.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div style={COMPOSER_WRAP}>
      <div style={INNER}>
        <textarea
          ref={textareaRef}
          style={TEXTAREA}
          rows={1}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          aria-label="Message composer"
        />
        <button
          type="button"
          style={canSend ? SEND_BTN : SEND_BTN_DISABLED}
          onClick={() => void handleSend()}
          disabled={!canSend}
          aria-label="Send message"
        >
          ↑
        </button>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "var(--sf-fg-4)",
          fontFamily: "var(--sf-font-text)",
          paddingLeft: 4,
        }}
      >
        Return to send · Shift+Return for new line
      </div>
    </div>
  );
}
