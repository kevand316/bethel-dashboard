// lib/rent.js
// Rent tab (plans/sms-reports.md, step 6): one checklist per month.
//
// rent_charges holds a row per resident per month (amount due); rent_payments the
// payments against it; rent_events the change log. The current month builds itself
// from the bed roster (occupied + recup beds with a name) and picks up new move-ins
// each time it is opened; it never deletes rows. Past months are left as they were.
// Any month can be reconciled by hand: Remove takes a name off that month only
// (the row and its payments stay, marked removed_at, so the sync never re-adds it;
// Undo puts it back), and Add person adds someone who isn't in Operations.
// Every query names the signed-in user's id; RLS backs it up.
//
// Exposes window.rent = { init(), open() }.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const round = (n) => Math.round(Number(n || 0) * 100) / 100;

  let month = null;   // 'YYYY-MM-01'
  let rows = [];      // charges for `month`, each with .payments (removed ones left out)
  let removedRows = []; // charges taken off `month` by hand
  let confirmId = null; // the row asking "Remove …?" 
  let pastDue = {};   // key -> unpaid balance from earlier months
  let busy = false;

  // Which homes are open, remembered on this device (a viewing preference,
  // not data, so localStorage is the right home for it). Homes start closed so
  // the tab opens as a short list of totals; the operator opens what they need.
  const OPEN_KEY = 'houseboss.rent.open';
  let opened = new Set();
  try { opened = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]').map(String)); } catch (_) {}
  function saveOpened() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...opened])); } catch (_) {}
  }

  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const currentMonth = () => `${ym(new Date())}-01`;
  const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); return `${ym(new Date(y, mo - 1 + n, 1))}-01`; };
  const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
  const key = (homeId, name) => `${homeId}|${String(name).trim().toLowerCase()}`;
  const paidOf = (r) => round(r.payments.reduce((s, p) => s + Number(p.amount), 0));
  const balanceOf = (r) => round(Math.max(0, Number(r.due) - paidOf(r)));

  async function uid() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.id || null;
  }
  async function actor() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.email || 'Dashboard';
  }
  async function logEvent(chargeId, action, detail) {
    const id = await uid();
    await sb.from('rent_events').insert({ user_id: id, charge_id: chargeId, action, detail, actor: await actor() });
  }

  // ── Roster → checklist ─────────────────────────────────────────────────────
  function rosterRows(m, userId) {
    const homes = Array.isArray(window.homes) ? window.homes : [];
    const out = [];
    for (const h of homes) {
      for (const b of h.beds || []) {
        if ((b.status === 'occupied' || b.status === 'recup') && String(b.name || '').trim()) {
          out.push({ user_id: userId, month: m, home_id: Number(h.id), home_name: h.name || '', bed_id: Number(b.id),
            resident_name: String(b.name).trim(), due: Number(b.rate) || 0 });
        }
      }
    }
    return out;
  }

  // Wait for the dashboard's real roster; until it loads, window.homes holds
  // placeholder homes that must never become rent rows.
  async function rosterReady() {
    for (let i = 0; i < 60 && !(window.isDataLoaded && window.isDataLoaded()); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return !!(window.isDataLoaded && window.isDataLoaded());
  }

  async function syncFromRoster(m) {
    if (!(await rosterReady())) return false;
    const id = await uid();
    const add = rosterRows(m, id);
    if (!add.length) return true;
    // Existing rows (and their edited amounts) are left alone.
    const { error } = await sb.from('rent_charges')
      .upsert(add, { onConflict: 'user_id,month,home_id,resident_name', ignoreDuplicates: true });
    if (error) { console.warn('[rent] sync failed:', error.message); return false; }
    return true;
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    const id = await uid();
    if (!id) return;
    if (month === currentMonth()) await syncFromRoster(month);
    const { data, error } = await sb.from('rent_charges').select('*, rent_payments(*)')
      .eq('user_id', id).eq('month', month).order('home_name').order('bed_id').order('resident_name');
    if (error) { $('rtBody').innerHTML = '<div class="tm-empty">Couldn\'t load rent. Check your connection.</div>'; return; }
    const all = (data || []).map((r) => ({ ...r, payments: (r.rent_payments || []).sort((a, b) => a.created_at.localeCompare(b.created_at)) }));
    rows = all.filter((r) => !r.removed_at);
    removedRows = all.filter((r) => r.removed_at);

    // Past due: unpaid balances from earlier months for the same resident and home.
    pastDue = {};
    if (rows.length) {
      const { data: earlier } = await sb.from('rent_charges').select('home_id, resident_name, due, rent_payments(amount)')
        .eq('user_id', id).lt('month', month).is('removed_at', null);
      for (const c of earlier || []) {
        const owed = Number(c.due) - (c.rent_payments || []).reduce((s, p) => s + Number(p.amount), 0);
        if (owed > 0) pastDue[key(c.home_id, c.resident_name)] = round((pastDue[key(c.home_id, c.resident_name)] || 0) + owed);
      }
    }
    render();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    $('rtTitle').textContent = monthLabel(month);
    $('rtToday').hidden = month === currentMonth();
    const homeIds = [...new Set(rows.map((r) => String(r.home_id)))];
    const allShut = homeIds.length > 0 && homeIds.every((h) => !opened.has(h));
    $('rtToggleAll').textContent = allShut ? 'Expand all' : 'Collapse all';
    $('rtToggleAll').hidden = homeIds.length < 2;
    const removedHtml = removedRows.length ? `<div class="rt-removed"><span class="rt-removed-label">Removed from ${esc(monthLabel(month))}:</span>
      ${removedRows.map((r) => `<span class="rt-removed-one">${esc(r.resident_name)}${r.home_name ? ` (${esc(r.home_name)})` : ''}
        <button class="rt-link rt-restore" type="button" data-id="${esc(r.id)}">Undo</button></span>`).join('')}</div>` : '';
    if (!rows.length) {
      const isCurrent = month === currentMonth();
      $('rtBody').innerHTML = `<div class="tm-empty">${isCurrent
        ? 'No one is in a bed with a name yet. Add residents in Operations and they appear here.'
        : `No rent checklist for ${esc(monthLabel(month))}.`}
        ${isCurrent ? '' : '<div class="tm-row" style="margin-top:0.75rem"><button class="btn btn-ghost tm-btn" id="rtCreate" type="button">Create from current roster</button></div>'}</div>${removedHtml}`;
      $('rtTotals').innerHTML = '';
      return;
    }
    const byHome = new Map();
    for (const r of rows) {
      if (!byHome.has(r.home_id)) byHome.set(r.home_id, { name: r.home_name || `Home ${r.home_id}`, rows: [] });
      byHome.get(r.home_id).rows.push(r);
    }
    const tot = (list) => list.reduce((t, r) => ({
      due: t.due + Number(r.due), paid: t.paid + paidOf(r), owed: t.owed + balanceOf(r),
      past: t.past + (pastDue[key(r.home_id, r.resident_name)] || 0),
    }), { due: 0, paid: 0, owed: 0, past: 0 });

    $('rtBody').innerHTML = [...byHome.entries()].map(([homeId, h]) => {
      const t = tot(h.rows);
      const shut = !opened.has(String(homeId));
      const unpaid = h.rows.filter((r) => balanceOf(r) > 0).length;
      return `<div class="rt-home${shut ? ' rt-collapsed' : ''}" data-home="${esc(homeId)}">
        <button type="button" class="rt-home-head" aria-expanded="${!shut}">
          <span class="rt-home-name"><span class="rt-chev" aria-hidden="true">${shut ? '▸' : '▾'}</span>${esc(h.name)}</span>
          <span class="rt-home-tot">${money(t.paid)} of ${money(t.due)} collected${unpaid ? ` · ${unpaid} unpaid` : ' ✓'}</span>
        </button>
        <div class="rt-home-rows"${shut ? ' hidden' : ''}>${h.rows.map(rowHtml).join('')}</div>
      </div>`;
    }).join('') + removedHtml;

    const t = tot(rows);
    $('rtTotals').innerHTML = `
      <div class="rt-tot"><label>Expected</label><span>${money(t.due)}</span></div>
      <div class="rt-tot"><label>Collected</label><span class="rt-ok">${money(t.paid)}</span></div>
      <div class="rt-tot"><label>Outstanding</label><span class="${t.owed > 0 ? 'rt-bad' : 'rt-ok'}">${money(t.owed)}</span></div>
      <div class="rt-tot"><label>Past due (earlier months)</label><span class="${t.past > 0 ? 'rt-bad' : ''}">${money(t.past)}</span></div>`;
  }

  function rowHtml(r) {
    const paid = paidOf(r);
    const bal = balanceOf(r);
    const status = bal <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
    const last = r.payments.at(-1);
    const past = pastDue[key(r.home_id, r.resident_name)] || 0;
    return `<div class="rt-row rt-${status.toLowerCase()}" data-id="${esc(r.id)}">
      <div class="rt-who">
        <span class="rt-name">${esc(r.resident_name)}</span>${r.bed_id != null ? `<span class="rt-bed">Bed ${esc(r.bed_id)}</span>` : ''}
        <span class="rt-status">${status}</span>
      </div>
      <div class="rt-figs">
        <label class="rt-fig">Due $<input class="rt-due-input" type="number" min="0" step="1" value="${esc(Number(r.due))}" aria-label="Amount due for ${esc(r.resident_name)}"></label>
        <span class="rt-fig">Paid <b>${money(paid)}</b></span>
        <span class="rt-fig">Owes <b class="rt-balance">${money(bal)}</b></span>
        ${past > 0 ? `<span class="rt-fig rt-bad">Past due <b class="rt-pastdue">${money(past)}</b></span>` : ''}
      </div>
      ${confirmId === r.id ? `<div class="rt-confirm">
        <span>Remove ${esc(r.resident_name)} from ${esc(monthLabel(month))}?${r.payments.length ? ' Their payments stay on record.' : ''} Other months aren't affected.</span>
        <button class="btn btn-red tm-btn rt-remove-yes" type="button">Yes, remove</button>
        <button class="btn btn-ghost tm-btn rt-remove-no" type="button">Keep</button>
      </div>` : ''}
      <div class="rt-actions">
        ${bal > 0 ? `<button class="btn btn-gold rt-paid-full" type="button">Paid in full</button>
        <input class="tm-input rt-partial-input" type="number" min="1" step="1" placeholder="Partial $" aria-label="Partial payment for ${esc(r.resident_name)}">
        <button class="btn btn-ghost rt-partial-add" type="button">Add</button>` : ''}
        ${confirmId === r.id ? '' : `<button class="tm-link tm-link-red rt-remove" type="button" aria-label="Remove ${esc(r.resident_name)} from this month">Remove</button>`}
      </div>
      ${last || r.payments.length ? `<div class="rt-pays">
        ${last ? `<span class="rt-last">Last paid ${esc(last.paid_on)} · ${esc(last.logged_by || '')}${last.source === 'text' ? ' (text)' : ''}</span>` : ''}
        ${r.payments.map((p) => `<span class="rt-pay" data-pay="${esc(p.id)}">${money(p.amount)}
          <button class="tm-link tm-link-red rt-pay-remove" type="button" aria-label="Remove ${money(p.amount)} payment">✕</button></span>`).join('')}
      </div>` : ''}
      <div class="tm-msg rt-msg" aria-live="polite"></div>
    </div>`;
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function addPayment(r, amount, el) {
    amount = round(amount);
    const msg = el.querySelector('.rt-msg');
    if (!(amount > 0)) { msg.textContent = 'Enter an amount.'; return; }
    if (amount > balanceOf(r)) { msg.textContent = `That's more than the ${money(balanceOf(r))} owed.`; return; }
    if (busy) return;
    busy = true;
    msg.textContent = 'Saving...';
    const id = await uid();
    const { error } = await sb.from('rent_payments').insert({
      user_id: id, charge_id: r.id, amount, logged_by: 'Dashboard', source: 'dashboard',
    });
    busy = false;
    if (error) { msg.textContent = 'Not saved, check connection and try again.'; return; }
    await logEvent(r.id, 'payment_added', `${money(amount)} for ${r.resident_name}`);
    await load();
  }

  async function removePayment(r, payId, el) {
    const msg = el.querySelector('.rt-msg');
    const id = await uid();
    const p = r.payments.find((x) => x.id === payId);
    const { error } = await sb.from('rent_payments').delete().eq('user_id', id).eq('id', payId);
    if (error) { msg.textContent = 'Not removed, check connection.'; return; }
    await logEvent(r.id, 'payment_removed', `${money(p?.amount)} for ${r.resident_name}`);
    await load();
  }

  async function setDue(r, value, el) {
    const due = round(value);
    const msg = el.querySelector('.rt-msg');
    if (!(due >= 0) || Number(r.due) === due) return;
    const id = await uid();
    const { error } = await sb.from('rent_charges').update({ due }).eq('user_id', id).eq('id', r.id);
    if (error) { msg.textContent = 'Not saved, check connection.'; return; }
    await logEvent(r.id, 'due_changed', `${r.resident_name}: ${money(r.due)} → ${money(due)}`);
    await load();
  }

  async function setRemoved(chargeId, removed) {
    const id = await uid();
    const r = [...rows, ...removedRows].find((x) => x.id === chargeId);
    const fields = removed ? { removed_at: new Date().toISOString(), removed_by: await actor() } : { removed_at: null, removed_by: null };
    const { error } = await sb.from('rent_charges').update(fields).eq('user_id', id).eq('id', chargeId);
    confirmId = null;
    if (error) { render(); return; }
    await logEvent(chargeId, removed ? 'resident_removed' : 'resident_restored', `${r?.resident_name} · ${monthLabel(month)}`);
    await load();
  }

  // ── Add person by hand (any month) ─────────────────────────────────────────
  function addPanel(show) {
    $('rtAddPanel').hidden = !show;
    $('rtAddMsg').textContent = '';
    if (!show) return;
    const homes = (Array.isArray(window.homes) ? window.homes : []).map((h) => [String(h.id), h.name]);
    for (const r of [...rows, ...removedRows]) {
      if (!homes.some(([hid]) => hid === String(r.home_id))) homes.push([String(r.home_id), r.home_name || `Home ${r.home_id}`]);
    }
    $('rtAddHome').innerHTML = homes.map(([hid, name]) => `<option value="${esc(hid)}">${esc(name)}</option>`).join('');
    $('rtAddName').value = '';
    $('rtAddDue').value = '';
    $('rtAddTitle').textContent = `Add a person to ${monthLabel(month)}`;
    $('rtAddName').focus();
  }

  async function addPerson() {
    const msg = $('rtAddMsg');
    const name = $('rtAddName').value.trim().replace(/\s+/g, ' ');
    const homeId = Number($('rtAddHome').value);
    const due = round($('rtAddDue').value);
    if (!name) { msg.textContent = 'Enter a name.'; return; }
    if (!$('rtAddHome').value) { msg.textContent = 'Add a home in Operations first.'; return; }
    if (!(due >= 0)) { msg.textContent = 'Enter the amount due.'; return; }
    const same = (r) => r.home_id === homeId && r.resident_name.toLowerCase() === name.toLowerCase();
    if (rows.some(same)) { msg.textContent = `${name} is already on ${monthLabel(month)} for that home.`; return; }
    const id = await uid();
    msg.textContent = 'Saving...';
    const back = removedRows.find(same);
    let chargeId, error;
    if (back) {
      // They were removed from this month: put that row back (payments and all).
      ({ error } = await sb.from('rent_charges').update({ removed_at: null, removed_by: null, due })
        .eq('user_id', id).eq('id', back.id));
      chargeId = back.id;
    } else {
      const home = $('rtAddHome').selectedOptions[0]?.textContent || '';
      let data;
      ({ data, error } = await sb.from('rent_charges').insert({
        user_id: id, month, home_id: homeId, home_name: home, bed_id: null, resident_name: name, due,
      }).select('id').single());
      chargeId = data?.id;
    }
    if (error) { msg.textContent = 'Not saved, check connection and try again.'; return; }
    await logEvent(chargeId, 'resident_added', `${name} · ${monthLabel(month)} · ${money(due)}`);
    opened.add(String(homeId));
    saveOpened();
    addPanel(false);
    await load();
  }

  async function showHistory() {
    const panel = $('rtHistory');
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    const id = await uid();
    const { data } = await sb.from('rent_charges').select('month, due, rent_payments(amount)').eq('user_id', id).is('removed_at', null);
    const months = new Map();
    for (const c of data || []) {
      const m = months.get(c.month) || { due: 0, paid: 0 };
      m.due += Number(c.due);
      m.paid += (c.rent_payments || []).reduce((s, p) => s + Number(p.amount), 0);
      months.set(c.month, m);
    }
    const list = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    panel.innerHTML = list.length ? list.map(([m, t]) => `
      <button type="button" class="rt-hist-row" data-month="${esc(m)}">
        <span>${esc(monthLabel(m))}</span>
        <span>${money(t.paid)} of ${money(t.due)} · <b class="${t.due - t.paid > 0 ? 'rt-bad' : 'rt-ok'}">${money(Math.max(0, t.due - t.paid))} outstanding</b></span>
      </button>`).join('') : '<div class="tm-note">No months yet.</div>';
  }

  function go(m) { month = m; confirmId = null; $('rtHistory').hidden = true; addPanel(false); load(); }

  function wire() {
    $('rtPrev').addEventListener('click', () => go(shift(month, -1)));
    $('rtNext').addEventListener('click', () => go(shift(month, 1)));
    $('rtToday').addEventListener('click', () => go(currentMonth()));
    $('rtHistoryBtn').addEventListener('click', showHistory);
    $('rtAddBtn').addEventListener('click', () => addPanel($('rtAddPanel').hidden));
    $('rtAddCancel').addEventListener('click', () => addPanel(false));
    $('rtAddSave').addEventListener('click', addPerson);
    $('rtAddPanel').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) addPerson(); });
    $('rtHistory').addEventListener('click', (e) => {
      const b = e.target.closest('.rt-hist-row');
      if (b) go(b.dataset.month);
    });
    $('rtToggleAll').addEventListener('click', () => {
      const ids = [...new Set(rows.map((r) => String(r.home_id)))];
      if (ids.every((h) => !opened.has(h))) ids.forEach((h) => opened.add(h));
      else ids.forEach((h) => opened.delete(h));
      saveOpened();
      render();
    });
    $('rtBody').addEventListener('click', async (e) => {
      if (e.target.closest('#rtCreate')) { await syncFromRoster(month); await load(); return; }
      const restore = e.target.closest('.rt-restore');
      if (restore) { setRemoved(restore.dataset.id, false); return; }
      const head = e.target.closest('.rt-home-head');
      if (head) {
        const id = head.closest('.rt-home').dataset.home;
        if (opened.has(id)) opened.delete(id); else opened.add(id);
        saveOpened();
        render();
        return;
      }
      const el = e.target.closest('.rt-row');
      if (!el) return;
      const r = rows.find((x) => x.id === el.dataset.id);
      if (!r) return;
      if (e.target.closest('.rt-paid-full')) addPayment(r, balanceOf(r), el);
      else if (e.target.closest('.rt-partial-add')) addPayment(r, Number(el.querySelector('.rt-partial-input').value), el);
      else if (e.target.closest('.rt-pay-remove')) removePayment(r, e.target.closest('.rt-pay').dataset.pay, el);
      else if (e.target.closest('.rt-remove')) { confirmId = r.id; render(); }
      else if (e.target.closest('.rt-remove-no')) { confirmId = null; render(); }
      else if (e.target.closest('.rt-remove-yes')) setRemoved(r.id, true);
    });
    $('rtBody').addEventListener('change', (e) => {
      const input = e.target.closest('.rt-due-input');
      const el = e.target.closest('.rt-row');
      if (input && el) setDue(rows.find((x) => x.id === el.dataset.id), Number(input.value), el);
    });
    $('rtBody').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest('.rt-due-input')) e.target.blur();
      if (e.key === 'Enter' && e.target.closest('.rt-partial-input')) e.target.closest('.rt-row').querySelector('.rt-partial-add').click();
    });
  }

  // Payments texted in land on an open Rent tab without a refresh.
  let channel = null;
  window.rentLive = false;
  async function subscribe() {
    if (channel) return;
    const id = await uid();
    if (!id) return;
    let timer = null;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if ($('view-rent').classList.contains('active')) load(); }, 300);
    };
    channel = sb.channel(`rent-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_payments', filter: `user_id=eq.${id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_charges', filter: `user_id=eq.${id}` }, refresh)
      .subscribe((status) => { window.rentLive = status === 'SUBSCRIBED'; });
  }

  function open() {
    if (!month) month = currentMonth();
    subscribe();
    load();
  }

  window.rent = { init: wire, open };
})();
