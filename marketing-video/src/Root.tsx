import "./index.css";
import { Composition } from "remotion";
import {
  MarketingVideo,
  FPS,
  WIDTH,
  HEIGHT,
  TOTAL_FRAMES,
} from "./Composition";
import {
  MarketingVideoWide,
  WIDE_FPS,
  WIDE_WIDTH,
  WIDE_HEIGHT,
  WIDE_TOTAL_FRAMES,
} from "./CompositionWide";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HeroVideo"
        component={MarketingVideo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="HeroVideoWide"
        component={MarketingVideoWide}
        durationInFrames={WIDE_TOTAL_FRAMES}
        fps={WIDE_FPS}
        width={WIDE_WIDTH}
        height={WIDE_HEIGHT}
      />
    </>
  );
};
