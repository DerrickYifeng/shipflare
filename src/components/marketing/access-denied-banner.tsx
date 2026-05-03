/**
 * Banner shown above the hero when sign-in is rejected by the
 * design-partner allowlist (NextAuth redirects to /?error=AccessDenied).
 *
 * Static "email founder" CTA — no form. We promote to a real request
 * form only if there's evidence of inbound interest worth moderating.
 */
export function AccessDeniedBanner() {
  return (
    <div
      role="alert"
      style={{
        background: 'rgba(255, 220, 100, 0.08)',
        borderTop: '1px solid rgba(255, 220, 100, 0.18)',
        borderBottom: '1px solid rgba(255, 220, 100, 0.18)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '14px 24px',
        textAlign: 'center',
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ fontWeight: 600 }}>ShipFlare is invite-only</strong>{' '}
      during the design partner phase. Email{' '}
      <a
        href="mailto:founder@shipflare.dev?subject=Design%20partner%20access"
        style={{ color: 'inherit', textDecoration: 'underline' }}
      >
        founder@shipflare.dev
      </a>{' '}
      for an invite.
    </div>
  );
}
