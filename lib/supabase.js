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

  // ── sbGetWithTs ────────────────────────────────────────────────────────────
  // Like sbGet, but also returns the updated_at timestamp for optimistic
  // concurrency (cross-device conflict detection, migration 002).
  // Returns: { data, updatedAt } on success.
  //          { data: null, updatedAt: null, failed: true } on error.
  // If the updated_at column does not exist yet (pre-migration), updatedAt is null
  // and callers should fall back to unconditional upsert behaviour.
  async function sbGetWithTs(id) {
    try {
      const { data: row, error } = await client
        .from('bethel_data')
        .select('data, updated_at')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.warn('[sbGetWithTs] error:', error.message);
        if (typeof showToast === 'function') showToast('Failed to load — check connection');
        return { data: null, updatedAt: null, failed: true };
      }

      return {
        data: row ? row.data : null,
        updatedAt: row ? (row.updated_at ?? null) : null,
      };
    } catch (e) {
      console.warn('[sbGetWithTs] unexpected error:', e);
      if (typeof showToast === 'function') showToast('Failed to load — check connection');
      return { data: null, updatedAt: null, failed: true };
    }
  }

  // ── sbSet ──────────────────────────────────────────────────────────────────
  // Pure upsert of { id, user_id, data } for the signed-in user.
  // Conflict resolution is on (id, user_id) — so each user has their own row
  // for each id ('homes', 'snapshots').
  // Does NOT touch #save-status — that is managed exclusively by lib/autosave.js.
  // Returns true on success, false on failure.
  async function sbSet(id, data) {
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) {
        console.warn('[sbSet] no authenticated user');
        return false;
      }

      const { error } = await client
        .from('bethel_data')
        .upsert({ id, user_id: user.id, data }, { onConflict: 'id,user_id' });

      if (error) {
        console.warn('[sbSet] error:', error.message);
        if (typeof showToast === 'function') showToast('Failed to save — check connection');
        return false;
      }

      return true;
    } catch (e) {
      console.warn('[sbSet] unexpected error:', e);
      if (typeof showToast === 'function') showToast('Failed to save — check connection');
      return false;
    }
  }

  // Expose on window so index.html and other scripts can use them.
  window._supabase = client;
  window.SB_LOAD_FAILED = SB_LOAD_FAILED;
  window.sbGet = sbGet;
  window.sbGetWithTs = sbGetWithTs;
  window.sbSet = sbSet;
})();
