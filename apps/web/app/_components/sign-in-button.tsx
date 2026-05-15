"use client";

import { authClient } from "@/auth-client";

interface SignInButtonProps {
  provider?: "github" | "google";
  callbackURL?: string;
  label?: string;
  variant?: "primary" | "secondary";
}

export function SignInButton({
  provider = "github",
  callbackURL = "/briefing",
  label,
  variant = "primary",
}: SignInButtonProps) {
  const defaultLabel = provider === "google" ? "Sign in with Google" : "Sign in with GitHub";
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={() =>
        authClient.signIn.social({
          provider,
          callbackURL,
        })
      }
      className={isPrimary ? "sf-cta-primary" : "sf-cta-secondary"}
    >
      {label ?? defaultLabel}
    </button>
  );
}
