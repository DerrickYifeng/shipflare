import { interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";

interface LiveTickerProps {
  /** Frame at which the count begins */
  startFrame: number;
  /** Value reached after the fast initial count */
  base: number;
  /** Additional value added per second after `base` is reached (continuous live tick) */
  tickPerSecond?: number;
  /** Duration of the initial fast count, in frames */
  initialFrames?: number;
  /** Optional prefix shown before the number (e.g. "+", "$") */
  prefix?: string;
  /** Optional suffix shown after the number (e.g. "k") */
  suffix?: string;
  style?: React.CSSProperties;
  /** FPS used for the per-second rate calc (defaults to 30 to match the comp) */
  fps?: number;
}

/**
 * A counter that races from 0 to `base` over `initialFrames` (eased), then
 * keeps ticking up at `tickPerSecond` so the number visually never stops
 * growing — communicates "live engagement happening right now."
 */
export const LiveTicker: React.FC<LiveTickerProps> = ({
  startFrame,
  base,
  tickPerSecond = 0,
  initialFrames = 28,
  prefix = "",
  suffix = "",
  style,
  fps = 30,
}) => {
  const frame = useCurrentFrame();

  const fastValue = interpolate(
    frame,
    [startFrame, startFrame + initialFrames],
    [0, base],
    {
      easing: BRAND_EASE,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const ongoingFrames = Math.max(0, frame - startFrame - initialFrames);
  const ongoingValue = (ongoingFrames / fps) * tickPerSecond;

  const total = Math.floor(fastValue + ongoingValue);
  const formatted = total.toLocaleString("en-US");

  return (
    <span style={style}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
};
