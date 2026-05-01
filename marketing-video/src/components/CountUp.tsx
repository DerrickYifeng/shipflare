import { interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";

interface CountUpProps {
  to: number;
  from?: number;
  startFrame?: number;
  durationFrames?: number;
  format?: (n: number) => string;
  style?: React.CSSProperties;
}

export const CountUp: React.FC<CountUpProps> = ({
  to,
  from = 0,
  startFrame = 0,
  durationFrames = 60,
  format = (n) => Math.round(n).toLocaleString("en-US"),
  style,
}) => {
  const frame = useCurrentFrame();
  const value = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [from, to],
    {
      easing: BRAND_EASE,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  return <span style={style}>{format(value)}</span>;
};
