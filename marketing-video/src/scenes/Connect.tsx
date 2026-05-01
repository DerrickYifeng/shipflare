import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { Cursor } from "../components/Cursor";
import { GithubIcon, GlobeIcon } from "../components/MethodIcons";

// Tight Connect: method picker → URL form → "Got it ✓" hold. No link viz.
const URL_TEXT = "example.app";
const TYPE_PER_CHAR = 4;

// Phase 0 — Method picker (URL or GitHub)
const PICKER_HOLD_END = 44;
const URL_CARD_CLICK = 50;
const PICKER_FADE_OUT = 66;

// Phase 1 — URL form
const FORM_FADE_IN = 58;
const TYPE_START = FORM_FADE_IN + 18;
const TYPE_END = TYPE_START + URL_TEXT.length * TYPE_PER_CHAR;
const SCAN_CLICK = TYPE_END + 16;
const READING_END = SCAN_CLICK + 24;

// Layout — URL primary (selected), GitHub alternative
const METHOD_URL_Y = 540;
const METHOD_GH_Y = 800;
const METHOD_CARD_W = 960;
const METHOD_CARD_H = 220;

const INPUT_Y = 580;
const INPUT_H = 130;
const BTN_Y = 740;
const BTN_H = 120;

// Cursor anchors
const CURSOR_OFFSCREEN: [number, number] = [1100, 1900];
const CURSOR_URL_CARD: [number, number] = [
  180,
  METHOD_URL_Y + METHOD_CARD_H / 2,
];
const CURSOR_INPUT: [number, number] = [380, INPUT_Y + INPUT_H / 2];
const CURSOR_BTN: [number, number] = [540, BTN_Y + BTN_H / 2];

export const Connect: React.FC = () => {
  const frame = useCurrentFrame();

  const captionEnter = interpolate(frame, [0, 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Cursor: offscreen → URL card → input → button
  const toUrlCard = interpolate(frame, [6, URL_CARD_CLICK - 4], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const toInput = interpolate(
    frame,
    [PICKER_FADE_OUT, TYPE_START - 6],
    [0, 1],
    {
      easing: BRAND_EASE,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  const toBtn = interpolate(frame, [TYPE_END + 2, SCAN_CLICK - 4], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const p1: [number, number] = [
    interpolate(toUrlCard, [0, 1], [CURSOR_OFFSCREEN[0], CURSOR_URL_CARD[0]]),
    interpolate(toUrlCard, [0, 1], [CURSOR_OFFSCREEN[1], CURSOR_URL_CARD[1]]),
  ];
  const p2: [number, number] = [
    interpolate(toInput, [0, 1], [p1[0], CURSOR_INPUT[0]]),
    interpolate(toInput, [0, 1], [p1[1], CURSOR_INPUT[1]]),
  ];
  const cursorX = interpolate(toBtn, [0, 1], [p2[0], CURSOR_BTN[0]]);
  const cursorY = interpolate(toBtn, [0, 1], [p2[1], CURSOR_BTN[1]]);

  const urlCardClick = interpolate(
    frame,
    [URL_CARD_CLICK, URL_CARD_CLICK + 14],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const scanClick = interpolate(frame, [SCAN_CLICK, SCAN_CLICK + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const click =
    frame < PICKER_FADE_OUT
      ? urlCardClick
      : frame >= SCAN_CLICK
        ? scanClick
        : 0;

  const pickerOp = interpolate(
    frame,
    [0, 18, PICKER_HOLD_END + 6, PICKER_FADE_OUT],
    [0, 1, 1, 0],
    { easing: BRAND_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const urlSelected = frame >= URL_CARD_CLICK;

  const formOp = interpolate(frame, [FORM_FADE_IN, FORM_FADE_IN + 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const inputFocused = frame >= FORM_FADE_IN;
  const typedChars = Math.max(
    0,
    Math.min(URL_TEXT.length, Math.floor((frame - TYPE_START) / TYPE_PER_CHAR)),
  );
  const typed = URL_TEXT.slice(0, typedChars);
  const caretOn =
    inputFocused && Math.floor(frame / 12) % 2 === 0 && frame < SCAN_CLICK;

  const btnDepress = interpolate(
    frame,
    [SCAN_CLICK, SCAN_CLICK + 8, SCAN_CLICK + 16],
    [1, 0.96, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const buttonLabel =
    frame < SCAN_CLICK
      ? "Scan →"
      : frame < READING_END
        ? "Reading…"
        : "Got it ✓";

  const buttonBg =
    frame >= READING_END ? "var(--sf-success)" : "var(--sf-accent)";

  return (
    <AbsoluteFill style={{ background: "var(--sf-bg-dark)" }}>
      {/* Persistent step header */}
      <div
        style={{
          position: "absolute",
          top: 200,
          left: 60,
          right: 60,
          opacity: captionEnter,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: "var(--sf-font-mono)",
            fontSize: 28,
            textTransform: "uppercase",
            letterSpacing: "-0.12px",
            color: "var(--sf-link-dark)",
            fontWeight: 600,
            marginBottom: 22,
          }}
        >
          Step 1
        </div>
        <div
          style={{
            fontFamily: "var(--sf-font-display)",
            fontSize: 76,
            fontWeight: 600,
            lineHeight: 1.1,
            letterSpacing: "-0.38px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          Connect your product.
        </div>
      </div>

      {/* PHASE 0 — Method picker */}
      {pickerOp > 0 ? (
        <>
          <MethodCard
            top={METHOD_URL_Y}
            opacity={pickerOp}
            icon={<GlobeIcon size={64} color="var(--sf-fg-on-dark-1)" />}
            title="Paste a URL"
            sub="We crawl your landing page"
            selected={urlSelected}
          />
          <MethodCard
            top={METHOD_GH_Y}
            opacity={pickerOp}
            icon={<GithubIcon size={64} color="var(--sf-fg-on-dark-1)" />}
            title="Connect a GitHub repo"
            sub="We read your README + code"
            selected={false}
          />
        </>
      ) : null}

      {/* PHASE 1 — URL form */}
      {formOp > 0 ? (
        <>
          <div
            style={{
              position: "absolute",
              top: INPUT_Y,
              left: 60,
              right: 60,
              height: INPUT_H,
              opacity: formOp,
              background: "var(--sf-bg-secondary)",
              borderRadius: 18,
              border: "3px solid var(--sf-accent)",
              display: "flex",
              alignItems: "center",
              padding: "0 32px",
              fontFamily: "var(--sf-font-mono)",
              fontSize: 44,
              color: "var(--sf-fg-1)",
              letterSpacing: "-0.12px",
              boxShadow: "0 0 0 6px rgba(0,113,227,0.18)",
            }}
          >
            <span style={{ color: "var(--sf-fg-4)", marginRight: 12 }}>
              https://
            </span>
            <span>{typed}</span>
            {caretOn ? (
              <span
                style={{
                  display: "inline-block",
                  width: 3,
                  height: 48,
                  background: "var(--sf-fg-1)",
                  marginLeft: 4,
                }}
              />
            ) : null}
          </div>

          <div
            style={{
              position: "absolute",
              top: BTN_Y,
              left: 60,
              right: 60,
              height: BTN_H,
              opacity: formOp,
              background: buttonBg,
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--sf-font-text)",
              fontSize: 44,
              fontWeight: 500,
              color: "#fff",
              letterSpacing: "-0.4px",
              transform: `scale(${btnDepress})`,
              transition: "background 200ms",
            }}
          >
            {buttonLabel}
          </div>
        </>
      ) : null}

      <Cursor x={cursorX} y={cursorY} click={click} />
    </AbsoluteFill>
  );
};

interface MethodCardProps {
  top: number;
  opacity: number;
  icon: React.ReactNode;
  title: string;
  sub: string;
  selected: boolean;
}

const MethodCard: React.FC<MethodCardProps> = ({
  top,
  opacity,
  icon,
  title,
  sub,
  selected,
}) => (
  <div
    style={{
      position: "absolute",
      top,
      left: 60,
      width: METHOD_CARD_W,
      height: METHOD_CARD_H,
      background: selected ? "rgba(0,113,227,0.12)" : "rgba(255,255,255,0.04)",
      border: selected
        ? "3px solid var(--sf-accent)"
        : "1px solid rgba(255,255,255,0.08)",
      borderRadius: 24,
      padding: "0 40px",
      display: "flex",
      alignItems: "center",
      gap: 32,
      opacity,
      boxShadow: selected ? "0 0 0 6px rgba(0,113,227,0.18)" : "none",
    }}
  >
    {icon}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontFamily: "var(--sf-font-display)",
          fontSize: 44,
          fontWeight: 600,
          letterSpacing: "-0.4px",
          color: "var(--sf-fg-on-dark-1)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: "var(--sf-font-text)",
          fontSize: 28,
          color: "var(--sf-fg-on-dark-3)",
          letterSpacing: "-0.224px",
          lineHeight: 1.3,
        }}
      >
        {sub}
      </div>
    </div>
  </div>
);
