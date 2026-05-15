"use client";

import { useCallback, useState, useTransition, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { addInvite } from "../actions";

const FORM: CSSProperties = {
  display: "flex",
  gap: 8,
  marginBottom: 18,
  flexWrap: "wrap",
};

const INPUT: CSSProperties = {
  flex: "1 1 240px",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--sf-border)",
  background: "var(--sf-bg-secondary)",
  fontFamily: "var(--sf-font-text)",
  fontSize: 13,
  color: "var(--sf-fg-1)",
  outline: "none",
};

const NOTE_INPUT: CSSProperties = {
  ...INPUT,
  flex: "2 1 320px",
};

const BUTTON: CSSProperties = {
  padding: "8px 18px",
  background: "var(--sf-accent)",
  color: "var(--sf-fg-on-dark-1)",
  border: "none",
  borderRadius: "var(--sf-radius-pill)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const ERROR: CSSProperties = {
  width: "100%",
  marginTop: -8,
  marginBottom: 12,
  padding: "6px 10px",
  background: "var(--sf-error-light)",
  color: "var(--sf-error-ink)",
  borderRadius: 6,
  fontSize: 12,
};

export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      const fd = new FormData();
      fd.set("email", email);
      fd.set("note", note);
      startTransition(async () => {
        const result = await addInvite(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setEmail("");
        setNote("");
        router.refresh();
      });
    },
    [email, note, router],
  );

  return (
    <>
      <form onSubmit={handleSubmit} style={FORM}>
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="founder@product.com"
          style={INPUT}
          autoComplete="off"
          required
          maxLength={254}
        />
        <input
          type="text"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional) — who, how you met, what they're building"
          style={NOTE_INPUT}
          maxLength={500}
        />
        <button type="submit" style={BUTTON} disabled={pending}>
          {pending ? "Adding…" : "Add invite"}
        </button>
      </form>
      {error && <div style={ERROR}>{error}</div>}
    </>
  );
}
