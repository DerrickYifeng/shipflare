"use client";

import { useState, type FormEvent, type CSSProperties } from "react";
import Link from "next/link";
import { SignInModal } from "@/components/auth/sign-in-modal";
import { type BannerVariant } from "./context-banner";

export interface WaitlistFormProps {
  initialEmail: string;
  referer: BannerVariant;
}

interface FormState {
  status: "idle" | "submitting" | "success" | "error";
  error: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm({ initialEmail, referer }: WaitlistFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [useCase, setUseCase] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [state, setState] = useState<FormState>({ status: "idle", error: null });
  const [signInOpen, setSignInOpen] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state.status === "submitting") return;
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_RE.test(trimmed) || trimmed.length > 254) {
      setState({ status: "error", error: "Please enter a valid email." });
      return;
    }
    // Honeypot tripped — silently "succeed" so bots can't probe.
    if (honeypot.trim() !== "") {
      setState({ status: "success", error: null });
      return;
    }
    setState({ status: "submitting", error: null });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          useCase: useCase.trim() || undefined,
          referer,
        }),
      });
      if (!res.ok) {
        setState({
          status: "error",
          error: "Something went wrong. Try again in a moment.",
        });
        return;
      }
      setState({ status: "success", error: null });
    } catch {
      setState({
        status: "error",
        error: "Network error. Check your connection and try again.",
      });
    }
  }

  if (state.status === "success") {
    return (
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          padding: "32px 24px clamp(96px, 18vh, 160px)",
          color: "var(--sf-fg-on-dark-1)",
          textAlign: "center",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: "var(--sf-radius-full)",
            background: "var(--sf-accent)",
            margin: "0 auto 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12.5l4.5 4.5L19 7"
              stroke="#fff"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2
          style={{
            fontFamily: "var(--sf-font-display)",
            fontSize: "var(--sf-text-h1)",
            fontWeight: 600,
            letterSpacing: "var(--sf-track-tight)",
            lineHeight: 1.1,
            margin: "0 0 12px",
          }}
        >
          You&rsquo;re on the list.
        </h2>
        <p
          style={{
            fontSize: "var(--sf-text-lg)",
            color: "var(--sf-fg-on-dark-2)",
            letterSpacing: "var(--sf-track-normal)",
            margin: "0 0 32px",
          }}
        >
          We&rsquo;ll email you when a slot opens.
        </p>
        <Link
          href="/"
          style={{
            color: "var(--sf-fg-on-dark-3)",
            fontSize: "var(--sf-text-sm)",
            textDecoration: "underline",
            textUnderlineOffset: 3,
            transition: "color var(--sf-dur-fast) var(--sf-ease-swift)",
          }}
        >
          ← Back to home
        </Link>
      </div>
    );
  }

  const pending = state.status === "submitting";

  return (
    <>
      <form
        onSubmit={handleSubmit}
        style={{
          maxWidth: 480,
          margin: "0 auto",
          padding: "0 24px clamp(64px, 14vh, 120px)",
          color: "var(--sf-fg-on-dark-1)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        aria-label="Request alpha access"
      >
        <FieldShell label="Email" htmlFor="waitlist-email">
          <input
            id="waitlist-email"
            name="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            maxLength={254}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "waitlist-email-error" : undefined}
            style={INPUT}
            autoFocus
          />
        </FieldShell>

        <FieldShell
          label="What would you ship faster?"
          htmlFor="waitlist-usecase"
          hint="Optional"
        >
          <textarea
            id="waitlist-usecase"
            name="useCase"
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="A few words about what you're building."
            style={{ ...INPUT, resize: "vertical", minHeight: 84, paddingTop: 14 }}
          />
        </FieldShell>

        {/* Honeypot — bots fill, humans don't see. */}
        <input
          name="company"
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          style={{
            position: "absolute",
            left: "-9999px",
            opacity: 0,
            pointerEvents: "none",
            height: 0,
            width: 0,
          }}
        />

        {state.error ? (
          <p
            id="waitlist-email-error"
            role="alert"
            style={{
              color: "var(--sf-error)",
              fontSize: "var(--sf-text-sm)",
              letterSpacing: "var(--sf-track-normal)",
              margin: 0,
            }}
          >
            {state.error}
          </p>
        ) : null}

        <SubmitButton pending={pending} />

        <button
          type="button"
          onClick={() => setSignInOpen(true)}
          style={LINK_BUTTON}
        >
          Already invited? Sign in
        </button>
      </form>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </>
  );
}

interface FieldShellProps {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}

function FieldShell({ label, htmlFor, hint, children }: FieldShellProps) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 16,
          fontSize: "var(--sf-text-xs)",
          fontFamily: "var(--sf-font-mono)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--sf-fg-on-dark-3)",
          marginBottom: 8,
        }}
      >
        <span>{label}</span>
        {hint ? (
          <span
            style={{
              textTransform: "none",
              letterSpacing: "var(--sf-track-normal)",
              color: "var(--sf-fg-on-dark-4)",
              flexShrink: 0,
            }}
          >
            {hint}
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function SubmitButton({ pending }: { pending: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="submit"
      disabled={pending}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginTop: 12,
        alignSelf: "center",
        minHeight: 48,
        padding: "0 32px",
        background: pending
          ? "var(--sf-accent)"
          : hover
            ? "var(--sf-accent-hover)"
            : "var(--sf-accent)",
        color: "#ffffff",
        border: "none",
        borderRadius: "var(--sf-radius-pill)",
        fontSize: "var(--sf-text-base)",
        fontFamily: "inherit",
        fontWeight: 500,
        letterSpacing: "var(--sf-track-tight)",
        cursor: pending ? "wait" : "pointer",
        opacity: pending ? 0.85 : 1,
        transition:
          "background var(--sf-dur-base) var(--sf-ease-swift), opacity var(--sf-dur-base) var(--sf-ease-swift)",
      }}
    >
      {pending ? "Sending…" : "Request access  →"}
    </button>
  );
}

const INPUT: CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  background: "rgba(255, 255, 255, 0.06)",
  color: "var(--sf-fg-on-dark-1)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: "var(--sf-radius-lg)",
  fontSize: "var(--sf-text-base)",
  letterSpacing: "var(--sf-track-normal)",
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
  transition:
    "border-color var(--sf-dur-base) var(--sf-ease-swift), background var(--sf-dur-base) var(--sf-ease-swift), box-shadow var(--sf-dur-base) var(--sf-ease-swift)",
};

const LINK_BUTTON: CSSProperties = {
  marginTop: 4,
  background: "transparent",
  border: "none",
  color: "var(--sf-fg-on-dark-3)",
  fontFamily: "inherit",
  fontSize: "var(--sf-text-sm)",
  letterSpacing: "var(--sf-track-normal)",
  cursor: "pointer",
  padding: 8,
  textDecoration: "underline",
  textUnderlineOffset: 3,
  transition: "color var(--sf-dur-fast) var(--sf-ease-swift)",
  alignSelf: "center",
};
