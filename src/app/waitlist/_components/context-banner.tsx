export type BannerVariant = 'denied' | 'no-email' | 'landing';

const COPY: Record<BannerVariant, { eyebrow: string; headline: string; sub: string }> = {
  denied: {
    eyebrow: 'Alpha access',
    headline: "You're not on the list yet.",
    sub: "Drop your details. We'll email when a slot opens.",
  },
  'no-email': {
    eyebrow: 'Alpha access',
    headline: "GitHub didn't share your email.",
    sub: "Enter it below and we'll add you to the waitlist.",
  },
  landing: {
    eyebrow: 'Private alpha',
    headline: 'Request access.',
    sub: "We're inviting design partners in waves.",
  },
};

export function ContextBanner({ variant }: { variant: BannerVariant }) {
  const copy = COPY[variant];
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'clamp(64px, 12vh, 120px) 24px 32px',
        color: 'var(--sf-fg-on-dark-1)',
        maxWidth: 720,
        margin: '0 auto',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--sf-font-mono)',
          fontSize: 'var(--sf-text-xs)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--sf-fg-on-dark-3)',
          marginBottom: 20,
        }}
      >
        {copy.eyebrow}
      </div>
      <h1
        style={{
          fontFamily: 'var(--sf-font-display)',
          fontSize: 'clamp(36px, 6vw, var(--sf-text-hero))',
          fontWeight: 600,
          letterSpacing: 'var(--sf-track-hero)',
          lineHeight: 1.07,
          margin: '0 0 16px',
        }}
      >
        {copy.headline}
      </h1>
      <p
        style={{
          fontSize: 'var(--sf-text-h3)',
          letterSpacing: 'var(--sf-track-normal)',
          lineHeight: 1.4,
          color: 'var(--sf-fg-on-dark-2)',
          margin: 0,
          maxWidth: 540,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {copy.sub}
      </p>
    </div>
  );
}
