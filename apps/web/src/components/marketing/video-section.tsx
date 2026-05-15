import { Ops } from '@/components/ui/ops';
import { HeroVideo } from './hero-video';

/**
 * VideoSection — dark ink bg, eyebrow + centered HeroVideo. No big heading
 * (the video itself opens with "You ship. We get you seen." callback to hero).
 */
export function VideoSection() {
  return (
    <section
      id="see-it"
      style={{
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '120px 24px',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--sf-max-width)',
          margin: '0 auto',
          textAlign: 'center',
        }}
      >
        <Ops
          tone="onDark"
          style={{
            display: 'block',
            color: 'var(--sf-fg-on-dark-3)',
            marginBottom: 32,
          }}
        >
          Demo · 39 seconds
        </Ops>
        <HeroVideo />
      </div>
    </section>
  );
}
