"use client";

import { authClient } from "@/auth-client";

interface SignInButtonProps {
  callbackURL?: string;
}

export function SignInButton({ callbackURL = "/chat" }: SignInButtonProps) {
  return (
    <button
      type="button"
      onClick={() =>
        authClient.signIn.social({
          provider: "github",
          callbackURL,
        })
      }
      style={{
        display: "inline-block",
        padding: "0.5rem 1rem",
        background: "#000",
        color: "#fff",
        border: "none",
        borderRadius: "4px",
        marginTop: "1rem",
        cursor: "pointer",
        fontSize: "1rem",
      }}
    >
      Sign in with GitHub
    </button>
  );
}
