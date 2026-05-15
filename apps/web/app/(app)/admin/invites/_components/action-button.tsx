"use client";

import { useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "../actions";

interface ActionButtonProps {
  /** Server action factory — passes back the result of the call. */
  action: () => Promise<ActionResult>;
  /** Idle button label. */
  label: string;
  /** Label shown while the action is in flight. */
  busyLabel?: string;
  /** Visual style — Apple-ish accent, ghost outline, or destructive red. */
  variant?: "accent" | "ghost" | "danger";
  /** Confirm prompt before firing. */
  confirm?: string;
}

const SIZE: CSSProperties = {
  padding: "4px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--sf-font-text)",
  cursor: "pointer",
};

const VARIANT: Record<NonNullable<ActionButtonProps["variant"]>, CSSProperties> = {
  accent: {
    background: "var(--sf-accent)",
    color: "var(--sf-fg-on-dark-1)",
    border: "none",
  },
  ghost: {
    background: "transparent",
    color: "var(--sf-fg-2)",
    border: "1px solid var(--sf-border)",
  },
  danger: {
    background: "transparent",
    color: "var(--sf-error-ink)",
    border: "1px solid var(--sf-error-light)",
  },
};

export function ActionButton({
  action,
  label,
  busyLabel,
  variant = "ghost",
  confirm,
}: ActionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    if (confirm && !window.confirm(confirm)) return;
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        // Keep the failure prominent — admin needs to know.
        window.alert(r.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      style={{ ...SIZE, ...VARIANT[variant], opacity: pending ? 0.5 : 1 }}
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? (busyLabel ?? "…") : label}
    </button>
  );
}
