// lib/auth.js
// Auth gate for every page except login.html.
//
// On load: checks for an active Supabase session. If none, redirects to login.html.
// Exposes window.requireAuth() for use in initData() and other async entrypoints.
// Exposes window.logout() for the logout button.
//
// Must be loaded AFTER lib/supabase.js (depends on window._supabase).

(function () {
  const client = window._supabase;

  // ── requireAuth ────────────────────────────────────────────────────────────
  // Call this at the start of any async function that loads user data.
  // Returns the session if authenticated, null if it redirected.
  //
  // Usage in initData():
  //   const session = await requireAuth();
  //   if (!session) return;
  async function requireAuth() {
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      window.location.href = '/login.html';
      return null;
    }
    return session;
  }

  // ── logout ─────────────────────────────────────────────────────────────────
  // Signs the user out and redirects to login.html.
  async function logout() {
    await client.auth.signOut();
    window.location.href = '/login.html';
  }

  // ── onAuthStateChange ──────────────────────────────────────────────────────
  // Handles token refresh and unexpected session loss (e.g. password changed
  // from another device, token revoked). Redirects to login.html on SIGNED_OUT.
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      window.location.href = '/login.html';
    }
  });

  window.requireAuth = requireAuth;
  window.logout = logout;
})();
