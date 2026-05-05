'use client';

import { useEffect, useRef } from 'react';

/**
 * HeroVideo — 16:9 brand video for the landing hero.
 * Plays when scrolled into view, pauses when out of view.
 * Source: marketing-video/out/hero-wide.mp4 (rendered via Remotion).
 */
export function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.35 },
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, []);

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
        ref={videoRef}
        src="/hero-demo.mp4"
        muted
        loop
        playsInline
        preload="metadata"
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
