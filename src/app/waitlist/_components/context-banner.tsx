export type BannerVariant = 'denied' | 'no-email' | 'landing';

const COPY: Record<BannerVariant, { headline: string; sub: string }> = {
  denied: {
    headline: "Your GitHub email isn't on the alpha list yet.",
    sub: "Drop your details — we'll get back to you when a slot opens.",
  },
  'no-email': {
    headline: "GitHub didn't share your email.",
    sub: "Enter it below and we'll add you to the waitlist.",
  },
  landing: {
    headline: 'ShipFlare is in private alpha.',
    sub: "Request access — we're inviting design partners in waves.",
  },
};

export function ContextBanner({ variant }: { variant: BannerVariant }) {
  const copy = COPY[variant];
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '64px 24px 24px',
        color: 'var(--sf-fg-on-dark-1)',
        maxWidth: 640,
        margin: '0 auto',
      }}
    >
      <h1
        style={{
          fontSize: 'var(--sf-text-h1)',
          fontWeight: 600,
          letterSpacing: 'var(--sf-track-tight)',
          margin: '0 0 12px',
        }}
      >
        {copy.headline}
      </h1>
      <p
        style={{
          fontSize: 'var(--sf-text-lg)',
          color: 'var(--sf-fg-on-dark-2)',
          margin: 0,
        }}
      >
        {copy.sub}
      </p>
    </div>
  );
}
