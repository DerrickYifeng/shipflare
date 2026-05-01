import { Audio, Series, staticFile } from "remotion";
import { Hook } from "./scenesWide/Hook";
import { Connect } from "./scenesWide/Connect";
import { Discovery } from "./scenesWide/Discovery";
import { Drafts } from "./scenesWide/Drafts";
import { Conversion } from "./scenesWide/Conversion";
import { CTA } from "./scenesWide/CTA";
import { Brand } from "./scenesWide/Brand";
import { SCENES, FPS } from "./Composition";

export const WIDE_FPS = FPS;
export const WIDE_WIDTH = 1920;
export const WIDE_HEIGHT = 1080;
export const WIDE_TOTAL_FRAMES = Object.values(SCENES).reduce(
  (a, b) => a + b,
  0,
);

const MUSIC_ENABLED = false;

export const MarketingVideoWide: React.FC = () => (
  <>
    {MUSIC_ENABLED ? (
      <Audio src={staticFile("music.mp3")} volume={0.35} />
    ) : null}
    <Series>
      <Series.Sequence durationInFrames={SCENES.hook}>
        <Hook />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.connect}>
        <Connect />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.discovery}>
        <Discovery />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.drafts}>
        <Drafts />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.conversion}>
        <Conversion />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.cta}>
        <CTA />
      </Series.Sequence>
      <Series.Sequence durationInFrames={SCENES.brand}>
        <Brand />
      </Series.Sequence>
    </Series>
  </>
);
