/**
 * HeroVideo — auto-playing 16:9 brand video for the landing hero.
 * Source: marketing-video/out/hero-wide.mp4 (rendered via Remotion).
 *
 * Borderless: video blends into the dark hero, only the rounded corners
 * keep it bounded. No shadow / no border / no surface bg.
 */
export function HeroVideo() {
  return (
    <div
      style={{
        maxWidth: 880,
        margin: '0 auto',
        borderRadius: 'var(--sf-radius-xl)',
        overflow: 'hidden',
      }}
    >
      <video
        src="/hero-demo.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-label="ShipFlare in action — finding threads, drafting replies, converting"
        style={{
          width: '100%',
          height: 'auto',
          display: 'block',
          aspectRatio: '16 / 9',
          objectFit: 'cover',
        }}
      />
    </div>
  );
}
