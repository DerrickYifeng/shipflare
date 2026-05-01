import { Audio, Series, staticFile } from "remotion";
import { Hook } from "./scenes/Hook";
import { Connect } from "./scenes/Connect";
import { Discovery } from "./scenes/Discovery";
import { Drafts } from "./scenes/Drafts";
import { Conversion } from "./scenes/Conversion";
import { CTA } from "./scenes/CTA";
import { Brand } from "./scenes/Brand";

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

// Storyline: Hook → Connect → Discovery → Drafts → Conversion → CTA → Brand
export const SCENES = {
  hook: 75, // 2.5s — logo + pain + promise
  connect: 195, // 6.5s — method picker → URL form → "Got it ✓"
  discovery: 210, // 7.0s — Social agent finds painpoint threads
  drafts: 180, // 6.0s — Reply + Post auto-drafted
  conversion: 240, // 8.0s — engagement live tickers
  cta: 180, // 6.0s — features + equation + stat, holds ~2s on URL
  brand: 90, // 3.0s — final big-logo memory shot
} as const;

export const TOTAL_FRAMES = Object.values(SCENES).reduce((a, b) => a + b, 0);

/** Drop a track at marketing-video/public/music.mp3 and flip this to true. */
const MUSIC_ENABLED = false;

export const MarketingVideo: React.FC = () => (
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
