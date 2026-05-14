// Phase 1 landing page. S7 replaces this with the founder dashboard
// (chat, team roster, plan view, drafts). For now it's a single sign-in CTA.

export default function Home() {
  return (
    <main>
      <h1>ShipFlare</h1>
      <p>Your AI marketing team.</p>
      <a
        href="/api/auth/sign-in/social?provider=github"
        style={{
          display: "inline-block",
          padding: "0.5rem 1rem",
          background: "#000",
          color: "#fff",
          textDecoration: "none",
          borderRadius: "4px",
          marginTop: "1rem",
        }}
      >
        Sign in with GitHub
      </a>
    </main>
  );
}
