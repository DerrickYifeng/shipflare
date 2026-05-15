import { Ops } from "@/components/ui/ops";

export interface ModuleSummary {
  id: string;
  displayName: string;
  live: boolean;
  score: number | null;
}

interface ModuleStripProps {
  modules: ModuleSummary[];
}

export function ModuleStrip({ modules }: ModuleStripProps) {
  return (
    <div
      role="list"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${modules.length}, 1fr)`,
        gap: 8,
      }}
    >
      {modules.map((m) => (
        <ModuleChip key={m.id} module={m} />
      ))}
    </div>
  );
}

function ModuleChip({ module: m }: { module: ModuleSummary }) {
  const live = m.live;
  return (
    <div
      role="listitem"
      data-testid={`module-chip-${m.id}`}
      style={{
        background: live ? "var(--sf-success-light)" : "var(--sf-bg-primary)",
        borderRadius: 8,
        padding: "12px 14px",
        opacity: live ? 1 : 0.55,
      }}
    >
      <Ops>{m.displayName}</Ops>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.4px",
          color:
            live && m.score != null ? "var(--sf-fg-1)" : "var(--sf-fg-3)",
          margin: "6px 0 4px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {m.score == null ? "—" : m.score}
      </div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          color: live ? "var(--sf-success-ink)" : "var(--sf-fg-3)",
          textTransform: "uppercase",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: live ? "var(--sf-success)" : "transparent",
            border: live ? "none" : "1px solid var(--sf-fg-3)",
            marginRight: 6,
            verticalAlign: "middle",
          }}
        />
        {live ? "Live" : "Planned"}
      </div>
    </div>
  );
}
