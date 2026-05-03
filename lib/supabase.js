// lib/supabase.js
// Thin wrapper around the Supabase JS SDK v2.
// Exposes window.sbGet, window.sbSet, window._supabase, and window.SB_LOAD_FAILED.
// Must be loaded AFTER the Supabase CDN script.
// ALL database calls in index.html go through here — never bypass with raw fetch.

(function () {
  const SUPABASE_URL = 'https://yqgccykbdihsjqlapghr.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxZ2NjeWtiZGloc2pxbGFwZ2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNDAyMTksImV4cCI6MjA4NzkxNjIxOX0.' +
    'XHgok8xbYDKekprYI2htAZL622P7YcycTsQ5HuP-VUs';

  const SB_LOAD_FAILED = Symbol('SB_LOAD_FAILED');

  // Build the client. supabase is the UMD global from the CDN script.
  const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── sbGet ──────────────────────────────────────────────────────────────────
  // Fetches the `data` column for a given row id, scoped to the signed-in user.
  // Returns: the parsed value (could be null if row doesn't exist yet),
  //          or SB_LOAD_FAILED on error.
  async function sbGet(id) {
    try {
      const { data: row, error } = await client
        .from('bethel_data')
        .select('data')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.warn('[sbGet] error:', error.message);
        if (typeof showToast === 'function') showToast('Failed to load — check connection');
        return SB_LOAD_FAILED;
      }

      return row ? row.data : null;
    } catch (e) {
      console.warn('[sbGet] unexpected error:', e);
      if (typeof showToast === 'function') showToast('Failed to load — check connection');
      return SB_LOAD_FAILED;
    }
  }

  // ── sbSet ──────────────────────────────────────────────────────────────────
  // Upserts { id, user_id, data } for the signed-in user.
  // Conflict resolution is on (id, user_id) — so each user has their own row
  // for each id ('homes', 'snapshots').
  // Updates #save-status element if present.
  async function sbSet(id, data) {
    const el = document.getElementById('save-status');
    if (el) { el.textContent = 'SAVING...'; el.className = 'saving'; }

    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) {
        console.warn('[sbSet] no authenticated user');
        if (el) { el.textContent = 'ERROR'; el.className = 'error'; }
        return;
      }

      const { error } = await client
        .from('bethel_data')
        .upsert({ id, user_id: user.id, data }, { onConflict: 'id,user_id' });

      if (error) {
        console.warn('[sbSet] error:', error.message);
        if (typeof showToast === 'function') showToast('Failed to save — check connection');
        if (el) { el.textContent = 'ERROR'; el.className = 'error'; }
        return;
      }

      if (el) { el.textContent = 'SAVED'; el.className = 'saved'; }
    } catch (e) {
      console.warn('[sbSet] unexpected error:', e);
      if (typeof showToast === 'function') showToast('Failed to save — check connection');
      if (el) { el.textContent = 'ERROR'; el.className = 'error'; }
    }
  }

  // Expose on window so index.html and other scripts can use them.
  window._supabase = client;
  window.SB_LOAD_FAILED = SB_LOAD_FAILED;
  window.sbGet = sbGet;
  window.sbSet = sbSet;
})();
