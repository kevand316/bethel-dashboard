// lib/outreach.js
// Outreach tab (plans/outreach.md): search the web for organizations that could
// refer clients, keep each search as a list, and use it as a call sheet.
//
// The outreach-search Edge Function does the search in the background and fills
// outreach_lists / outreach_orgs; this file polls while a list is searching. The
// dashboard only ever updates notes and call status, and deletes lists. Every
// query names the signed-in user's id; RLS backs it up.
//
// Notes save as you type and show their real state: Saving..., Saved ✓, or
// Not saved (retrying), and a failed save keeps retrying until it lands.
//
// Exposes window.outreach = { init(), open() }.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const AREA_KEY = 'houseboss.outreach.area';
  const STALE_MS = 7 * 60 * 1000; // a search still "searching" after this never finished
  const POLL_MS = 5000;
  const STATUSES = [
    ['not_called', 'Not called'], ['called', 'Called'], ['left_message', 'Left message'],
    ['interested', 'Interested'], ['not_fit', 'Not a fit'],
  ];

  // Who refers clients to housing. Each fills the box; the operator can edit before sending.
  const GUIDE = [
    ['Probation & parole', 'probation and parole offices'],
    ['Hospitals', 'hospital case management, social work and discharge planning departments'],
    ['Behavioral health', 'county behavioral health and mental health clinics'],
    ['Treatment & detox', 'detox and substance use treatment programs'],
    ['Reentry', 'reentry programs for people leaving jail or prison'],
    ['Homeless services', 'homeless services, shelters and housing navigation programs'],
    ['Veterans', 'VA and veterans service organizations'],
    ['Courts', 'drug courts, collaborative courts and public defender offices'],
    ['Recuperative care', 'recuperative care and medical respite programs'],
    ['Health plans', 'health plan care management and community supports (housing) programs'],
    ['Faith-based', 'churches and faith-based recovery ministries'],
    ['DV & women', "domestic violence and women's shelters"],
  ];

  let lists = [];            // newest first, each with .orgs
  const opened = new Set();  // list ids open on screen
  let confirmDelete = null;  // list id asking "Delete this list?"
  let pollTimer = null;
  let loaded = false;

  // Pending saves per org: fields not yet confirmed by the database.
  const pending = new Map(); // org id -> { fields, timer, retry }

  async function uid() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.id || null;
  }
  const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const stale = (l) => l.status === 'searching' && Date.now() - new Date(l.created_at).getTime() > STALE_MS;
  const state = (l) => (stale(l) ? 'failed' : l.status);
  const telHref = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

  // ── Data ───────────────────────────────────────────────────────────────────
  async function load() {
    const id = await uid();
    if (!id) return;
    const { data, error } = await sb.from('outreach_lists').select('*, outreach_orgs(*)')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(200);
    if (error) {
      $('orLists').innerHTML = '<div class="tm-empty">Couldn\'t load your lists. Check your connection and reopen this tab.</div>';
      return;
    }
    lists = (data || []).map((l) => ({ ...l, orgs: (l.outreach_orgs || []).sort((a, b) => a.sort - b.sort) }));
    loaded = true;
    render();
    schedulePoll();
  }

  // While anything is searching, check on it; redraw only lists whose status changed.
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!lists.some((l) => l.status === 'searching' && !stale(l))) return;
    pollTimer = setTimeout(poll, POLL_MS);
  }
  async function poll() {
    const id = await uid();
    const waiting = lists.filter((l) => l.status === 'searching' && !stale(l)).map((l) => l.id);
    if (!id || !waiting.length) return;
    if (!$('view-outreach').classList.contains('active') || document.hidden) { schedulePoll(); return; }
    const { data } = await sb.from('outreach_lists').select('*, outreach_orgs(*)').eq('user_id', id).in('id', waiting);
    for (const fresh of data || []) {
      if (fresh.status === 'searching') continue;
      const i = lists.findIndex((l) => l.id === fresh.id);
      if (i < 0) continue;
      lists[i] = { ...fresh, orgs: (fresh.outreach_orgs || []).sort((a, b) => a.sort - b.sort) };
      if (fresh.status === 'done') opened.add(fresh.id); // show the results as they land
      renderList(lists[i]);
    }
    // Lists deleted elsewhere stop being polled.
    const gone = waiting.filter((w) => !(data || []).some((d) => d.id === w));
    if (gone.length) { lists = lists.filter((l) => !gone.includes(l.id)); render(); }
    schedulePoll();
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  async function send(query, area) {
    const msg = $('orMsg');
    query = (query ?? $('orQuery').value).trim();
    area = (area ?? $('orArea').value).trim();
    if (!query) { msg.textContent = 'Type what kind of organization to look for.'; return; }
    try { localStorage.setItem(AREA_KEY, area); } catch (_) {}
    $('orSend').disabled = true;
    msg.textContent = 'Starting the search...';
    const { data, error } = await sb.functions.invoke('outreach-search', { body: { query, area } });
    $('orSend').disabled = false;
    if (error) {
      let text = 'Couldn\'t start the search. Check your connection and try again.';
      try { text = (await error.context.json()).error || text; } catch (_) {}
      msg.textContent = text;
      return;
    }
    msg.textContent = '';
    $('orQuery').value = '';
    grow();
    lists.unshift({ ...data.list, orgs: [] });
    render();
    schedulePoll();
  }

  // ── Saving notes and call status ─────────────────────────────────────────────
  function saveLabel(orgId, text, bad) {
    const el = document.querySelector(`.or-org[data-id="${orgId}"] .or-save`);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('or-save-bad', !!bad);
  }
  function headCounts(listId) {
    const l = lists.find((x) => x.id === listId);
    const el = document.querySelector(`.or-list[data-id="${listId}"] .or-meta`);
    if (l && el) el.innerHTML = metaHtml(l);
  }

  function queueSave(org, fields, delay) {
    Object.assign(org, fields);
    const p = pending.get(org.id) || { fields: {} };
    Object.assign(p.fields, fields);
    clearTimeout(p.timer);
    clearTimeout(p.retry);
    pending.set(org.id, p);
    saveLabel(org.id, 'Saving...');
    p.timer = setTimeout(() => flush(org), delay);
  }

  async function flush(org) {
    const p = pending.get(org.id);
    if (!p) return;
    const fields = { ...p.fields };
    const id = await uid();
    const { error } = await sb.from('outreach_orgs')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('user_id', id).eq('id', org.id);
    const now = pending.get(org.id);
    if (error) {
      saveLabel(org.id, 'Not saved, retrying...', true);
      if (now) now.retry = setTimeout(() => flush(org), 4000);
      return;
    }
    // Only clear what was sent; anything typed meanwhile is still pending.
    if (now) {
      for (const [k, v] of Object.entries(fields)) if (now.fields[k] === v) delete now.fields[k];
      if (!Object.keys(now.fields).length) pending.delete(org.id);
    }
    if (!pending.has(org.id)) saveLabel(org.id, 'Saved ✓');
    headCounts(org.list_id);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function metaHtml(l) {
    const s = state(l);
    if (s === 'searching') return '<span class="or-searching">Searching the web... about 2 minutes</span>';
    if (s === 'failed') return '<span class="or-failed">Didn\'t finish</span>';
    const n = l.orgs.length;
    const count = (k) => l.orgs.filter((o) => o.call_status === k).length;
    const bits = [`${n} organization${n === 1 ? '' : 's'}`];
    if (count('interested')) bits.push(`${count('interested')} interested`);
    const called = l.orgs.filter((o) => o.call_status !== 'not_called').length;
    if (called) bits.push(`${called} contacted`);
    return bits.map(esc).join(' · ');
  }

  function orgHtml(o) {
    const web = safeUrl(o.website);
    const src = safeUrl(o.source_url);
    const missing = (t) => `<span class="or-missing">${t}</span>`;
    return `<div class="or-org" data-id="${esc(o.id)}">
      <div class="or-info">
        <div class="or-name">${esc(o.name)}${o.category ? ` <span class="rp-badge">${esc(o.category)}</span>` : ''}</div>
        ${o.why ? `<div class="or-why">${esc(o.why)}</div>` : ''}
        <dl class="or-facts">
          <dt>Phone</dt><dd>${o.phone ? `<a href="tel:${esc(telHref(o.phone))}">${esc(o.phone)}</a>${o.phone_label ? ` <span class="or-sub">${esc(o.phone_label)}</span>` : ''}` : missing('No phone found')}</dd>
          <dt>Contact</dt><dd>${o.contact_name ? `${esc(o.contact_name)}${o.contact_title ? ` <span class="or-sub">${esc(o.contact_title)}</span>` : ''}` : missing('No named contact found')}</dd>
          <dt>Email</dt><dd>${o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : missing('No email found')}</dd>
          <dt>Address</dt><dd>${o.address ? esc(o.address) : missing('No address found')}</dd>
          <dt>Links</dt><dd>${web ? `<a href="${esc(web)}" target="_blank" rel="noopener">${esc(host(web) || 'Website')}</a>` : ''}${web && src ? ' · ' : ''}${src ? `<a class="or-source" href="${esc(src)}" target="_blank" rel="noopener">Source</a>` : ''}${!web && !src ? missing('None') : ''}</dd>
        </dl>
      </div>
      <div class="or-call">
        <label class="or-label" for="ors-${esc(o.id)}">Status</label>
        <select class="tm-select or-status" id="ors-${esc(o.id)}">${STATUSES.map(([k, t]) =>
          `<option value="${k}" ${o.call_status === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label class="or-label" for="orn-${esc(o.id)}">Notes</label>
        <textarea class="tm-input or-notes" id="orn-${esc(o.id)}" maxlength="5000" placeholder="Who you spoke to, what they said, next step">${esc(o.notes)}</textarea>
        <div class="or-save" aria-live="polite"></div>
      </div>
    </div>`;
  }

  function listInner(l) {
    const s = state(l);
    const open = opened.has(l.id);
    const body = s === 'searching'
      ? '<div class="tm-note">Claude is searching the web and checking contact pages. You can leave this tab; the list fills in when it\'s ready.</div>'
      : s === 'failed'
        ? `<div class="tm-msg">${esc(l.error || 'The search didn\'t finish. Try again.')}</div>
           <button class="btn btn-ghost tm-btn or-retry" type="button">Search again</button>`
        : `${l.summary ? `<p class="or-summary">${esc(l.summary)}</p>` : ''}
           ${l.orgs.length ? l.orgs.map(orgHtml).join('') : '<div class="tm-empty">No organizations found. Try different words or a bigger area.</div>'}
           <div class="tm-note">Found on the web by Claude: check the source before relying on a number.</div>`;
    return `<button type="button" class="or-list-head" aria-expanded="${open}">
        <span class="rt-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="or-q">${esc(l.query)}</span>
        <span class="or-meta">${metaHtml(l)}</span>
        <span class="or-when">${esc(l.area ? `${l.area} · ` : '')}${esc(when(l.created_at))}</span>
      </button>
      <div class="or-body"${open ? '' : ' hidden'}>
        ${body}
        <div class="tm-row or-list-actions">
          ${confirmDelete === l.id
            ? '<span class="tm-msg">Delete this list? Your notes on it go too.</span><button class="btn btn-red tm-btn or-delete-yes" type="button">Yes, delete</button><button class="btn btn-ghost tm-btn or-delete-no" type="button">Keep</button>'
            : '<button class="tm-link tm-link-red or-delete" type="button">Delete list</button>'}
        </div>
      </div>`;
  }

  function renderList(l) {
    const el = document.querySelector(`.or-list[data-id="${l.id}"]`);
    if (!el) { render(); return; }
    el.innerHTML = listInner(l);
  }

  function render() {
    if (!loaded && !lists.length) return;
    $('orLists').innerHTML = lists.length
      ? lists.map((l) => `<div class="or-list" data-id="${esc(l.id)}">${listInner(l)}</div>`).join('')
      : '<div class="tm-empty">No searches yet. Pick a category above or type your own.</div>';
  }

  function grow() {
    const t = $('orQuery');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function init() {
    $('orGuide').innerHTML = GUIDE.map(([label, q]) =>
      `<button type="button" class="or-chip" data-q="${esc(q)}">${esc(label)}</button>`).join('');
    try { $('orArea').value = localStorage.getItem(AREA_KEY) || ''; } catch (_) {}

    $('orGuide').addEventListener('click', (e) => {
      const chip = e.target.closest('.or-chip');
      if (!chip) return;
      $('orQuery').value = chip.dataset.q;
      grow();
      $('orQuery').focus();
    });
    $('orQuery').addEventListener('input', grow);
    $('orQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('orSend').addEventListener('click', () => send());

    $('orLists').addEventListener('click', (e) => {
      const listEl = e.target.closest('.or-list');
      if (!listEl) return;
      const l = lists.find((x) => x.id === listEl.dataset.id);
      if (!l) return;
      if (e.target.closest('.or-list-head')) {
        if (opened.has(l.id)) opened.delete(l.id); else opened.add(l.id);
        renderList(l);
      } else if (e.target.closest('.or-delete')) { confirmDelete = l.id; renderList(l); }
      else if (e.target.closest('.or-delete-no')) { confirmDelete = null; renderList(l); }
      else if (e.target.closest('.or-delete-yes')) deleteList(l);
      else if (e.target.closest('.or-retry')) send(l.query, l.area);
    });
    $('orLists').addEventListener('input', (e) => {
      if (!e.target.matches('.or-notes')) return;
      const org = findOrg(e.target);
      if (org) queueSave(org, { notes: e.target.value }, 700);
    });
    $('orLists').addEventListener('change', (e) => {
      if (!e.target.matches('.or-status')) return;
      const org = findOrg(e.target);
      if (org) queueSave(org, { call_status: e.target.value }, 0);
    });
    // Typing then leaving: save right away rather than waiting out the pause.
    $('orLists').addEventListener('focusout', (e) => {
      if (!e.target.matches('.or-notes')) return;
      const org = findOrg(e.target);
      const p = org && pending.get(org.id);
      if (p && !p.retry) { clearTimeout(p.timer); flush(org); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (pending.size) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function findOrg(el) {
    const orgEl = el.closest('.or-org');
    const listEl = el.closest('.or-list');
    const l = lists.find((x) => x.id === listEl?.dataset.id);
    return l?.orgs.find((o) => o.id === orgEl?.dataset.id) || null;
  }

  async function deleteList(l) {
    const id = await uid();
    const { error } = await sb.from('outreach_lists').delete().eq('user_id', id).eq('id', l.id);
    confirmDelete = null;
    if (error) { renderList(l); return; }
    lists = lists.filter((x) => x.id !== l.id);
    opened.delete(l.id);
    render();
  }

  function open() { load(); }

  window.outreach = { init, open };
})();
