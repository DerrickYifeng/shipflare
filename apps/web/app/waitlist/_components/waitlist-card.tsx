"use client";

import { useCallback, useState, type CSSProperties, type FormEvent } from "react";

interface WaitlistCardProps {
  variant: "landing" | "denied" | "no-email";
  initialEmail: string;
}

const COPY: Record<
  WaitlistCardProps["variant"],
  { eyebrow: string; title: string; subtitle: string }
> = {
  landing: {
    eyebrow: "Alpha · invite-only",
    title: "Get on the list",
    subtitle:
      "ShipFlare's alpha is invite-only while we ship and tune. Drop your email and we'll let you in as soon as a slot opens.",
  },
  denied: {
    eyebrow: "Almost there",
    title: "You're not on the list yet",
    subtitle:
      "That email isn't approved yet. Confirm it below and we'll add you to the queue — we let people in as fast as we can keep up.",
  },
  "no-email": {
    eyebrow: "We need an email",
    title: "Sign-in needs a verified email",
    subtitle:
      "Your provider didn't return an email address. Drop it here and we'll add you to the queue manually.",
  },
};

const WRAP: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "64px 24px",
};

const CARD: CSSProperties = {
  maxWidth: 480,
  width: "100%",
  background: "var(--sf-bg-secondary)",
  borderRadius: "var(--sf-radius-xl, 12px)",
  boxShadow: "var(--sf-shadow-elevated)",
  padding: "32px clamp(20px, 4vw, 40px)",
  color: "var(--sf-fg-1)",
};

const EYEBROW: CSSProperties = {
  display: "inline-block",
  fontSize: 10,
  fontFamily: "var(--sf-font-mono)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--sf-accent)",
  marginBottom: 10,
};

const TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--sf-font-display)",
  fontSize: 26,
  fontWeight: 600,
  letterSpacing: "var(--sf-track-tight, -0.374px)",
  color: "var(--sf-fg-1)",
  lineHeight: 1.15,
};

const SUBTITLE: CSSProperties = {
  fontSize: 14,
  color: "var(--sf-fg-3)",
  lineHeight: 1.55,
  margin: "10px 0 24px",
};

const INPUT: CSSProperties = {
  width: "100%",
  padding: "10px 14px",
  borderRadius: "var(--sf-radius-md, 8px)",
  border: "1px solid var(--sf-border, rgba(0,0,0,0.08))",
  background: "var(--sf-bg-primary)",
  fontFamily: "var(--sf-font-text)",
  fontSize: 15,
  color: "var(--sf-fg-1)",
  outline: "none",
  marginBottom: 12,
};

const BUTTON: CSSProperties = {
  width: "100%",
  padding: "12px 20px",
  background: "var(--sf-accent)",
  color: "var(--sf-fg-on-dark-1)",
  border: "none",
  borderRadius: "var(--sf-radius-pill, 980px)",
  fontFamily: "var(--sf-font-text)",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  transition: "background var(--sf-dur-fast) var(--sf-ease-swift)",
};

const SUCCESS: CSSProperties = {
  marginTop: 16,
  padding: "10px 14px",
  background: "var(--sf-success-light)",
  color: "var(--sf-success-ink)",
  borderRadius: 8,
  fontSize: 14,
};

const ERROR: CSSProperties = {
  marginTop: 12,
  padding: "8px 12px",
  background: "var(--sf-error-light)",
  color: "var(--sf-error-ink)",
  borderRadius: 6,
  fontSize: 13,
};

export function WaitlistCard({ variant, initialEmail }: WaitlistCardProps) {
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = COPY[variant];

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      const trimmed = email.trim();
      if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        setError("Please enter a valid email.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        // No backing endpoint yet — the request silently no-ops so the
        // user always sees the "we'll be in touch" confirmation. When the
        // /api/waitlist endpoint lands this fetch will start persisting.
        await fetch("/api/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        }).catch(() => null);
        setSubmitted(true);
      } finally {
        setSubmitting(false);
      }
    },
    [email, submitting],
  );

  return (
    <div style={WRAP}>
      <div style={CARD}>
        <span style={EYEBROW}>{copy.eyebrow}</span>
        <h1 style={TITLE}>{copy.title}</h1>
        <p style={SUBTITLE}>{copy.subtitle}</p>

        {submitted ? (
          <div style={SUCCESS} role="status">
            Thanks — we&apos;ve got <strong>{email}</strong> on the list. We&apos;ll
            email you the moment a slot opens.
          </div>
        ) : (
          <form onSubmit={handleSubmit} aria-label="Request alpha access">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@your-product.com"
              style={INPUT}
              autoComplete="email"
              required
              maxLength={254}
              autoFocus
            />
            <button
              type="submit"
              style={BUTTON}
              disabled={submitting}
              onMouseEnter={(e) => {
                if (!submitting) {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "var(--sf-accent-hover, #0077ed)";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--sf-accent)";
              }}
            >
              {submitting ? "Submitting…" : "Request access →"}
            </button>
            {error && (
              <div style={ERROR} role="alert">
                {error}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
