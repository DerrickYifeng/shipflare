'use client';

/**
 * Root-level error boundary. Catches errors in the root layout itself.
 * Unlike (app)/error.tsx this must render its own <html>/<body>.
 *
 * See: https://nextjs.org/docs/app/building-your-application/routing/error-handling#handling-global-errors
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          backgroundColor: '#f5f5f7',
          color: '#1d1d1f',
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontSize: '28px',
              fontWeight: 600,
              letterSpacing: '0.231px',
              marginBottom: '8px',
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: '14px',
              color: '#6e6e73',
              maxWidth: '420px',
              marginBottom: '24px',
              lineHeight: 1.47,
            }}
          >
            We hit an unexpected error. The issue has been logged — try again in
            a moment.
            {error.digest && (
              <>
                <br />
                <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px' }}>
                  Ref: {error.digest}
                </span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: '44px',
              padding: '8px 16px',
              background: '#0071e3',
              color: '#fff',
              border: 'none',
              borderRadius: '10px',
              fontSize: '17px',
              letterSpacing: '-0.374px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
