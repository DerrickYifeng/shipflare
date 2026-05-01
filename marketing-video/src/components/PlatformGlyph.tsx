interface Props {
  platform: "reddit" | "x";
  size?: number;
}

export const PlatformGlyph: React.FC<Props> = ({ platform, size = 36 }) => {
  if (platform === "x") {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "#000",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--sf-font-display)",
          fontSize: size * 0.55,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        𝕏
      </div>
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#ff4500",
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--sf-font-display)",
        fontSize: size * 0.55,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      r
    </div>
  );
};
