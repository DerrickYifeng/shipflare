"use client";

import { useCallback, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface OnboardingFormProps {
  initialName: string;
  initialUrl: string;
  initialDescription: string;
}

const PAGE: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 24px",
};

const CARD: CSSProperties = {
  maxWidth: 520,
  width: "100%",
  background: "var(--sf-bg-secondary)",
  borderRadius: "var(--sf-radius-xl, 12px)",
  boxShadow: "var(--sf-shadow-card)",
  padding: "32px clamp(20px, 4vw, 40px)",
};

const HEADER_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 6,
};

const LOGO_DOT: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  background: "linear-gradient(135deg, var(--sf-accent-light), var(--sf-accent))",
  color: "var(--sf-fg-on-dark-1)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  fontSize: 16,
  fontFamily: "var(--sf-font-display)",
};

const TITLE: CSSProperties = {
  fontFamily: "var(--sf-font-display)",
  fontSize: 24,
  fontWeight: 600,
  color: "var(--sf-fg-1)",
  letterSpacing: "var(--sf-track-tight, -0.374px)",
  margin: 0,
};

const SUBTITLE: CSSProperties = {
  fontSize: 14,
  color: "var(--sf-fg-3)",
  marginBottom: 24,
  marginTop: 4,
  lineHeight: 1.55,
};

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: 10,
  fontFamily: "var(--sf-font-mono)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--sf-fg-3)",
  marginBottom: 6,
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
  transition: "border-color var(--sf-dur-fast) var(--sf-ease-swift)",
};

const TEXTAREA: CSSProperties = {
  ...INPUT,
  fontSize: 14,
  lineHeight: 1.55,
  minHeight: 96,
  resize: "vertical",
};

const FIELD_ROW: CSSProperties = {
  marginBottom: 18,
};

const SUBMIT: CSSProperties = {
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

const ERROR: CSSProperties = {
  marginTop: 12,
  padding: "8px 12px",
  background: "var(--sf-error-light)",
  color: "var(--sf-error-ink)",
  borderRadius: 6,
  fontSize: 13,
};

export function OnboardingForm({
  initialName,
  initialUrl,
  initialDescription,
}: OnboardingFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [description, setDescription] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Your product needs a name so the team knows what they're marketing.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/product", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            url: url.trim() || null,
            description: description.trim() || null,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${res.status})`);
        }
        router.replace("/briefing");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setSubmitting(false);
      }
    },
    [name, url, description, submitting, router],
  );

  return (
    <main style={PAGE}>
      <form style={CARD} onSubmit={handleSubmit} aria-label="Onboarding">
        <div style={HEADER_ROW}>
          <span style={LOGO_DOT} aria-hidden="true">
            ✦
          </span>
          <h1 style={TITLE}>Tell us about your product</h1>
        </div>
        <p style={SUBTITLE}>
          Two minutes. Your CMO and the rest of the team start working the
          moment you submit — discovering threads, drafting posts, planning
          the week.
        </p>

        <div style={FIELD_ROW}>
          <label htmlFor="product-name" style={FIELD_LABEL}>
            Product name <span style={{ color: "var(--sf-accent)" }}>·</span>{" "}
            required
          </label>
          <input
            id="product-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ShipFlare"
            style={INPUT}
            autoFocus
            required
            maxLength={120}
          />
        </div>

        <div style={FIELD_ROW}>
          <label htmlFor="product-url" style={FIELD_LABEL}>
            Website
          </label>
          <input
            id="product-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://shipflare.ai"
            style={INPUT}
            maxLength={250}
          />
        </div>

        <div style={FIELD_ROW}>
          <label htmlFor="product-description" style={FIELD_LABEL}>
            What does it do?
          </label>
          <textarea
            id="product-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="AI marketing autopilot for indie developers — finds where users hang out, drafts replies, posts the ones you approve."
            style={TEXTAREA}
            maxLength={400}
          />
        </div>

        <button
          type="submit"
          style={SUBMIT}
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
          {submitting ? "Setting up your team…" : "Start working with my team →"}
        </button>

        {error && (
          <div style={ERROR} role="alert">
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
