// lib/reports.js
// Reports tab + Profit Calculator "Save to Reports" (plans/sms-reports.md, step 3).
//
// Reports arrive by text (Edge Function sms-inbound), from the dashboard, or from
// the Profit Calculator. Every query names the signed-in user's id; RLS backs it up.
// Realtime on `reports` (also RLS-filtered) keeps the list current.
//
// Exposes window.reports = { open(), init() } and window.reportsLive (true once the
// realtime subscription is up; the tests wait on it).

(function () {
  const sb = window._supabase;

  const BUCKETS = [
    ['all', 'All'],
    ['incidents', 'Incidents'],
    ['maintenance', 'Maintenance'],
    ['cleanings', 'Cleanings'],
    ['move_ins_outs', 'Move-ins/outs'],
    ['inventory', 'Inventory'],
    ['projections', 'Projections'],
    ['announcements', 'Announcements'],
  ];
  const label = (b) => (BUCKETS.find(([k]) => k === b) || [b, b])[1];
  const SUBTYPE = { emergency: 'Emergency', conflict: 'Conflict', complaint: 'Complaint', move_in: 'Move-in', move_out: 'Move-out', snapshot: 'Portfolio snapshot' };

  let reports = [];
  let filter = { bucket: 'all', home: '', person: '', from: '', to: '' };
  let openId = null;
  let mode = 'view'; // 'view' | 'edit' | 'confirm-delete'
  let flash = '';    // confirmation shown in the detail view after an edit
  let channel = null;
  let loaded = false;
  window.reportsLive = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const homeList = () => (Array.isArray(window.homes) ? window.homes : []);

  async function uid() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.id || null;
  }

  function when(iso) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function phone(e164) {
    const d = String(e164 || '').replace(/^\+1/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (e164 || '');
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function load() {
    const id = await uid();
    if (!id) return;
    const { data, error } = await sb.from('reports').select('*').eq('user_id', id)
      .order('created_at', { ascending: false }).limit(1000);
    if (error) {
      $('rpList').innerHTML = '<div class="tm-empty">Couldn\'t load reports. Check your connection and reopen this tab.</div>';
      return;
    }
    reports = data || [];
    loaded = true;
    render();
  }

  async function subscribe() {
    if (channel) return;
    const id = await uid();
    if (!id) return;
    channel = sb.channel(`reports-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reports', filter: `user_id=eq.${id}` }, () => load())
      .subscribe((status) => { window.reportsLive = status === 'SUBSCRIBED'; });
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  function passes(r, ignoreBucket) {
    if (!ignoreBucket && filter.bucket !== 'all' && r.bucket !== filter.bucket) return false;
    if (filter.home && String(r.home_id ?? '') !== filter.home) return false;
    if (filter.person && (r.sender_name || '') !== filter.person) return false;
    const day = r.created_at.slice(0, 10);
    const local = new Date(r.created_at);
    const localDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    if (filter.from && (localDay || day) < filter.from) return false;
    if (filter.to && (localDay || day) > filter.to) return false;
    return true;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function renderChips() {
    const pool = reports.filter((r) => passes(r, true));
    $('rpChips').innerHTML = BUCKETS.map(([key, text]) => {
      const n = key === 'all' ? pool.length : pool.filter((r) => r.bucket === key).length;
      return `<button type="button" class="rp-chip${filter.bucket === key ? ' active' : ''}" data-bucket="${key}">${text} <span>${n}</span></button>`;
    }).join('');
  }

  function renderFilters() {
    const homeSel = $('rpHome');
    const people = [...new Set(reports.map((r) => r.sender_name).filter(Boolean))].sort();
    const homes = homeList().map((h) => [String(h.id), h.name]);
    for (const r of reports) {
      if (r.home_id != null && !homes.some(([id]) => id === String(r.home_id))) homes.push([String(r.home_id), r.home_name || `Home ${r.home_id}`]);
    }
    homeSel.innerHTML = '<option value="">All homes</option>' +
      homes.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    homeSel.value = filter.home;
    const personSel = $('rpPerson');
    personSel.innerHTML = '<option value="">Everyone</option>' +
      people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    personSel.value = people.includes(filter.person) ? filter.person : '';
  }

  function renderList() {
    const list = reports.filter((r) => passes(r, false));
    if (!list.length) {
      $('rpList').innerHTML = `<div class="tm-empty">${reports.length ? 'No reports match these filters.' :
        'No reports yet. Staff can text them to 1-888-BOSS-502, or use New report.'}</div>`;
      return;
    }
    $('rpList').innerHTML = list.map((r) => `
      <button type="button" class="rp-card${r.urgent ? ' rp-urgent' : ''}" data-id="${esc(r.id)}">
        <div class="rp-card-top">
          <span class="rp-badge">${esc(label(r.bucket))}${r.subtype && SUBTYPE[r.subtype] ? ` · ${esc(SUBTYPE[r.subtype])}` : ''}</span>
          ${r.urgent ? '<span class="rp-badge rp-badge-urgent">Urgent</span>' : ''}
          <span class="rp-when">${esc(when(r.created_at))}</span>
        </div>
        <div class="rp-title">${esc(r.title)}</div>
        ${r.summary ? `<div class="rp-summary">${esc(r.summary)}</div>` : ''}
        <div class="rp-meta">
          ${r.home_name ? `<span>${esc(r.home_name)}</span>` : ''}
          ${r.sender_name ? `<span>${esc(r.sender_name)}</span>` : ''}
          <span>${r.source === 'text' ? 'By text' : r.source === 'calculator' ? 'Profit Calculator' : 'Dashboard'}</span>
        </div>
      </button>`).join('');
  }

  function render() {
    renderChips();
    renderFilters();
    renderList();
    if (openId) renderDetail();
  }

  function factsTable(rows) {
    if (!rows.length) return '';
    return `<table class="rp-facts">${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  }

  function projectionRows(d) {
    const i = d.inputs || {};
    const r = d.results || {};
    const money = (n) => (typeof n === 'number' ? '$' + Math.round(n).toLocaleString() : (n ?? ''));
    return [
      ['Beds', i.beds], ['Bedrooms', i.bedrooms], ['Occupancy', i.occ != null ? `${i.occ}%` : ''],
      ['Rate per bed', money(i.rate)], ['Rent', money(i.exp_rent)], ['Utilities', money(i.exp_utilities)],
      ['Supplies', money(i.exp_supplies)], ['Staff', money(i.exp_staff)], ['Operations', money(i.exp_operations)],
      ['Low / high rate', `${money(i.low_rate)} / ${money(i.high_rate)}`],
      ...Object.entries(r).map(([k, v]) => [k, v]),
    ].filter(([, v]) => v !== undefined && v !== '');
  }

  // A portfolio snapshot carried over from the retired Snapshots tab
  // (migration 015): the Overview figures on the day it was taken.
  function snapshotHtml(sn) {
    const m = (n) => '$' + Math.round(Number(n || 0)).toLocaleString();
    const rows = factsTable([
      ['Monthly revenue', m(sn.revenue)], ['Monthly expenses', m(sn.expenses)], ['Monthly cashflow', m(sn.cashflow)],
      ['Annual cashflow', m(sn.annual)], ['Margin', `${sn.margin ?? 0}%`], ['Occupancy', `${sn.occPct ?? 0}%`],
      ['Beds', `${sn.beds ?? 0} (${sn.clients ?? 0} occupied, ${sn.vacant ?? 0} vacant${sn.recup ? `, ${sn.recup} recuperative` : ''})`],
    ]);
    const homes = Array.isArray(sn.homeBreakdown) ? sn.homeBreakdown : [];
    return rows + (homes.length ? `<div class="rp-subhead">By home</div>` + factsTable(homes.map((h) => [
      h.name, `${m(h.revenue)} revenue · ${m(h.expenses)} expenses · ${m(h.cashflow)} cashflow · ${h.occ ?? 0}/${h.beds ?? 0} beds`,
    ])) : '');
  }

  async function renderDetail() {
    const r = reports.find((x) => x.id === openId);
    const box = $('rpDetail');
    if (!r) { closeDetail(); return; }
    box.hidden = false;
    document.body.classList.add('rp-detail-open');
    const d = r.details || {};
    const facts = Array.isArray(d.facts) ? d.facts.map((f) => [f.label, f.value]) : [];
    const convo = Array.isArray(d.conversation) ? d.conversation : [];

    const homeOptions = '<option value="">No home</option>' + homeList().map((h) =>
      `<option value="${esc(h.id)}" ${Number(h.id) === Number(r.home_id) ? 'selected' : ''}>${esc(h.name)}</option>`).join('');

    const body = mode === 'edit' ? `
      <div class="qc-field"><label for="rpEditTitle">Title</label><input id="rpEditTitle" maxlength="200" value="${esc(r.title)}"></div>
      <div class="qc-field"><label for="rpEditSummary">Details</label><textarea id="rpEditSummary" class="tm-input rp-textarea">${esc(r.summary)}</textarea></div>
      <div class="tm-grid">
        <div class="qc-field"><label for="rpEditBucket">Bucket</label><select id="rpEditBucket" class="tm-select">
          ${BUCKETS.slice(1).map(([k, t]) => `<option value="${k}" ${k === r.bucket ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="qc-field"><label for="rpEditHome">Home</label><select id="rpEditHome" class="tm-select">${homeOptions}</select></div>
      </div>
      <div class="tm-row">
        <button class="btn btn-gold tm-btn" id="rpEditSave" type="button">Save</button>
        <button class="btn btn-ghost tm-btn rp-edit-cancel" type="button">Cancel</button>
        <span class="tm-msg" id="rpEditStatus" aria-live="polite"></span>
      </div>` : `
      <div class="rp-meta rp-meta-detail">
        <span>${esc(when(r.created_at))}</span>
        ${r.home_name ? `<span>${esc(r.home_name)}</span>` : ''}
        ${r.sender_name ? `<span>${esc(r.sender_name)}${r.sender_phone ? ` · ${esc(phone(r.sender_phone))}` : ''}</span>` : ''}
      </div>
      ${r.summary ? `<p class="rp-detail-summary">${esc(r.summary)}</p>` : ''}
      ${d.snapshot ? snapshotHtml(d.snapshot) : factsTable(r.bucket === 'projections' ? projectionRows(d) : facts)}
      ${d.roster ? rosterBox(d.roster) : ''}
      ${r.bucket === 'announcements' && Array.isArray(d.replies) && d.replies.length ? `<div class="rp-subhead">Replies</div><div class="rp-convo">${d.replies.map((x) =>
        `<div class="rp-msg rp-msg-in"><b>${esc(x.from)}:</b> ${esc(x.text)}</div>`).join('')}</div>` : ''}
      <div class="rp-photos" id="rpPhotos"></div>
      <div id="rpNotified"></div>
      ${convo.length ? `<div class="rp-subhead">Text conversation</div><div class="rp-convo">${convo.map((m) =>
        `<div class="rp-msg rp-msg-${m.from === 'staff' ? 'in' : 'out'}">${esc(m.text)}</div>`).join('')}</div>` : ''}
      <div class="tm-msg" id="rpEditStatus" aria-live="polite">${esc(flash)}</div>
      <div class="tm-actions rp-actions">
        ${r.bucket === 'projections' && d.inputs ? '<button class="btn btn-gold rp-load-calc" type="button">Load into Profit Calculator</button>' : ''}
        <button class="btn btn-ghost rp-edit" type="button">Edit</button>
        <button class="btn btn-ghost rp-print" type="button">Print / PDF</button>
        ${mode === 'confirm-delete'
          ? '<button class="btn btn-red rp-delete-confirm" type="button">Yes, delete</button><button class="btn btn-ghost rp-delete-cancel" type="button">Keep</button>'
          : '<button class="btn btn-red rp-delete" type="button">Delete</button>'}
      </div>`;

    box.innerHTML = `
      <div class="rp-detail-inner" role="dialog" aria-modal="true" aria-label="${esc(r.title)}">
        <div class="rp-detail-head">
          <div>
            <span class="rp-badge">${esc(label(r.bucket))}${r.subtype && SUBTYPE[r.subtype] ? ` · ${esc(SUBTYPE[r.subtype])}` : ''}</span>
            ${r.urgent ? '<span class="rp-badge rp-badge-urgent">Urgent</span>' : ''}
            <div class="rp-detail-title">${esc(r.title)}</div>
          </div>
          <button class="btn btn-ghost rp-close" id="rpDetailClose" type="button" aria-label="Close">✕</button>
        </div>
        ${body}
      </div>`;
    if (mode !== 'edit') { loadPhotos(r); loadNotified(r); }
  }

  async function loadNotified(r) {
    const id = await uid();
    const { data } = await sb.from('notifications').select('member_name, phone, status, created_at')
      .eq('user_id', id).eq('report_id', r.id).order('created_at');
    const box = $('rpNotified');
    if (!box || openId !== r.id) return;
    const label = { test: 'logged', queued: 'queued', accepted: 'queued', sending: 'sending', sent: 'sent',
      delivered: 'delivered', undelivered: 'not delivered', failed: 'failed' };
    box.innerHTML = data?.length
      ? '<div class="rp-subhead">Notified</div>' + data.map((n) =>
        `<div class="rp-notified-row"><span>${esc(n.member_name || phone(n.phone))}</span><span class="rp-ns rp-ns-${esc(n.status)}">${esc(label[n.status] || n.status || '')}</span></div>`).join('')
      : '';
  }

  // Move-in/out roster change: what it is, where it stands, and (if pending)
  // the owner's Apply / Reject buttons.
  function rosterBox(ro) {
    const c = ro.change || ro;
    const what = c.action === 'move_in'
      ? `Move in ${c.resident_name}${c.rate ? ` at $${c.rate}` : ''}${c.bed_number ? `, bed ${c.bed_number}` : ''}`
      : `Move out ${c.resident_name}`;
    const label = { pending: 'Pending approval', processing: 'Applying...', applied: 'Applied to roster',
      failed: 'Not applied', rejected: 'Rejected' }[ro.status] || ro.status || '';
    return `<div class="rp-roster rp-roster-${esc(ro.status)}">
      <div class="rp-subhead">Roster change</div>
      <div><b>${esc(label)}</b>: ${esc(what)}</div>
      ${ro.result ? `<div class="tm-note">${esc(ro.result)}${ro.decided_by ? ` (${esc(ro.decided_by)})` : ''}</div>` : ''}
      ${ro.status === 'pending' ? `<div class="tm-actions">
        <button class="btn btn-gold rp-roster-apply" type="button">Apply to roster</button>
        <button class="btn btn-red rp-roster-reject" type="button">Reject</button></div>
        <div class="tm-note">Or a manager can text APPROVE ${esc(ro.code)}.</div>` : ''}
      <div class="tm-msg" id="rpRosterMsg" aria-live="polite"></div>
    </div>`;
  }

  async function decideRoster(decision) {
    const msg = $('rpRosterMsg');
    if (msg) msg.textContent = decision === 'approve' ? 'Applying...' : 'Rejecting...';
    const { data, error } = await sb.functions.invoke('roster-apply', { body: { report_id: openId, decision } });
    let text = data?.message || '';
    if (error) { try { text = (await error.context.json()).message || (await error.context.json()).error; } catch (_) {} }
    await load();
    const after = $('rpRosterMsg');
    if (after && text && error) after.textContent = text;
    // Pull the new roster into this tab so the Overview shows it.
    if (!error && decision === 'approve' && typeof window.reloadHomesFromServer === 'function') window.reloadHomesFromServer();
  }

  async function loadPhotos(r) {
    const id = await uid();
    const { data: rows } = await sb.from('report_photos').select('storage_path').eq('user_id', id).eq('report_id', r.id);
    if (!rows?.length || openId !== r.id) return;
    const { data: urls } = await sb.storage.from('report-photos').createSignedUrls(rows.map((p) => p.storage_path), 600);
    const box = $('rpPhotos');
    if (!box || !urls) return;
    box.innerHTML = urls.filter((u) => u.signedUrl).map((u) =>
      `<a href="${esc(u.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(u.signedUrl)}" alt="Report photo"></a>`).join('');
  }

  function openDetail(id) { openId = id; mode = 'view'; flash = ''; renderDetail(); }
  function closeDetail() {
    openId = null; mode = 'view';
    $('rpDetail').hidden = true;
    $('rpDetail').innerHTML = '';
    document.body.classList.remove('rp-detail-open');
  }

  async function saveEdit() {
    const status = $('rpEditStatus');
    const title = $('rpEditTitle').value.trim();
    if (!title) { status.textContent = 'Title is required'; return; }
    const homeId = $('rpEditHome').value;
    const home = homeList().find((h) => String(h.id) === homeId);
    status.textContent = 'Saving...';
    const id = await uid();
    const { error } = await sb.from('reports').update({
      title, summary: $('rpEditSummary').value.trim(), bucket: $('rpEditBucket').value,
      home_id: home ? Number(home.id) : null, home_name: home ? home.name : null,
      updated_at: new Date().toISOString(),
    }).eq('user_id', id).eq('id', openId);
    if (error) { status.textContent = 'Not saved, check connection and try again'; return; }
    mode = 'view';
    flash = 'Saved ✓';
    await load(); // re-renders the open detail in view mode, showing the flash
  }

  async function deleteOpen() {
    const id = await uid();
    const target = openId;
    const { error } = await sb.from('reports').delete().eq('user_id', id).eq('id', target);
    if (error) { mode = 'view'; renderDetail(); return; }
    closeDetail();
    reports = reports.filter((r) => r.id !== target);
    render();
  }

  function printOpen() {
    const src = document.querySelector('#rpDetail .rp-detail-inner');
    if (!src) return;
    let out = $('rpPrint');
    if (!out) { out = document.createElement('div'); out.id = 'rpPrint'; document.body.appendChild(out); }
    const ts = new Date().toLocaleString();
    out.innerHTML = `<div class="rp-print-head">${esc(window.orgName || 'HouseBoss.AI')} · Report · printed ${esc(ts)}</div>` + src.innerHTML;
    document.body.classList.add('printing-report');
    const done = () => { document.body.classList.remove('printing-report'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ── New report from the dashboard ──────────────────────────────────────────
  function toggleNew(show) {
    $('rpNewForm').hidden = !show;
    if (show) {
      $('rpNewHome').innerHTML = '<option value="">No home</option>' +
        homeList().map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
      $('rpNewTitle').focus();
    }
    $('rpNewStatus').textContent = '';
  }

  async function saveNew() {
    const status = $('rpNewStatus');
    const title = $('rpNewTitle').value.trim();
    if (!title) { status.textContent = 'Title is required'; return; }
    const home = homeList().find((h) => String(h.id) === $('rpNewHome').value);
    status.textContent = 'Saving...';
    const id = await uid();
    const { data: created, error } = await sb.from('reports').insert({
      user_id: id, bucket: $('rpNewBucket').value, title, summary: $('rpNewSummary').value.trim(),
      home_id: home ? Number(home.id) : null, home_name: home ? home.name : null,
      urgent: $('rpNewUrgent').checked, source: 'dashboard',
    }).select('id').single();
    if (error) { status.textContent = 'Not saved, check connection and try again. Your entry is still here.'; return; }
    // Same people hear about it as for a texted report (notification rules).
    sb.functions.invoke('notify-report', { body: { report_id: created.id } })
      .catch((e) => console.warn('[reports] notify failed:', e));
    $('rpNewTitle').value = ''; $('rpNewSummary').value = ''; $('rpNewUrgent').checked = false;
    toggleNew(false);
    await load();
  }

  // ── Send announcement (dashboard) ──────────────────────────────────────────
  // Same server path as texting "announce ...": the platform logs it and texts
  // everyone picked. Preview shows the real count before anything is sent.
  let anTimer = null;

  function anAudience() {
    const vals = (box) => [...document.querySelectorAll(`#${box} input:checked`)].map((c) => c.value);
    return { everyone: $('anEveryone').checked, roles: vals('anRoles'), homes: vals('anHomes').map(Number), member_ids: vals('anPeople') };
  }

  async function anOpen(show) {
    $('anPanel').hidden = !show;
    $('anConfirm').hidden = true;
    $('anStatus').textContent = '';
    if (!show) return;
    const id = await uid();
    const [{ data: roles }, { data: people }] = await Promise.all([
      sb.from('team_roles').select('name').eq('user_id', id).order('sort_order'),
      sb.from('team_members').select('id, name, status').eq('user_id', id).eq('status', 'active').order('name'),
    ]);
    const box = (items) => items.map(([v, t]) => `<label class="tm-check"><input type="checkbox" value="${esc(v)}"> ${esc(t)}</label>`).join('');
    $('anRoles').innerHTML = box((roles || []).map((r) => [r.name, r.name]));
    $('anHomes').innerHTML = box(homeList().map((h) => [h.id, h.name]));
    $('anPeople').innerHTML = box((people || []).map((m) => [m.id, m.name]));
    anPreview();
    $('anMessage').focus();
  }

  function anPreview() {
    clearTimeout(anTimer);
    $('anConfirm').hidden = true;
    anTimer = setTimeout(async () => {
      const a = anAudience();
      if (!a.everyone && !a.roles.length && !a.homes.length && !a.member_ids.length) {
        $('anPreview').textContent = 'Pick who it goes to.';
        $('anPreview').dataset.count = '0';
        return;
      }
      const { data, error } = await sb.functions.invoke('announce', { body: { preview: true, audience: a } });
      $('anPreview').textContent = error ? 'Couldn\'t check the audience, check connection.'
        : data.count ? `Goes to ${data.description}.` : 'No one matches yet (only people who replied YES get texts).';
      $('anPreview').dataset.count = error ? '0' : String(data.count);
    }, 250);
  }

  function anAsk() {
    if (!$('anMessage').value.trim()) { $('anStatus').textContent = 'Type a message first.'; return; }
    const n = Number($('anPreview').dataset.count || 0);
    if (!n) { $('anStatus').textContent = 'Pick who it goes to.'; return; }
    $('anStatus').textContent = '';
    $('anConfirmText').textContent = `Send to ${n} ${n === 1 ? 'person' : 'people'} now?`;
    $('anConfirm').hidden = false;
  }

  async function anSend() {
    $('anConfirm').hidden = true;
    $('anStatus').textContent = 'Sending...';
    const { data, error } = await sb.functions.invoke('announce', {
      body: { message: $('anMessage').value.trim(), audience: anAudience() },
    });
    if (error) {
      let msg = 'Not sent, check connection and try again.';
      try { msg = (await error.context.json()).error || msg; } catch (_) {}
      $('anStatus').textContent = msg;
      return;
    }
    $('anStatus').textContent = `Sent to ${data.count} ✓`;
    $('anMessage').value = '';
    if (loaded) load();
  }

  // ── Profit Calculator: Save to Reports ─────────────────────────────────────
  const QC_INPUTS = [
    ['beds', 'qc-beds'], ['bedrooms', 'qc-bedrooms'], ['occ', 'qc-occ'], ['rate', 'qc-rate'],
    ['exp_rent', 'qc-exp-rent'], ['exp_utilities', 'qc-exp-utilities'], ['exp_supplies', 'qc-exp-supplies'],
    ['exp_staff', 'qc-exp-staff'], ['exp_operations', 'qc-exp-operations'],
    ['low_rate', 'qc-low-rate'], ['high_rate', 'qc-high-rate'],
  ];
  const QC_RESULTS = [
    ['Verdict', 'qc-verdict'], ['Monthly revenue', 'qc-revenue'], ['Monthly expenses', 'qc-expenses-out'],
    ['Monthly cashflow', 'qc-cashflow'], ['Annual cashflow', 'qc-annual'], ['Margin', 'qc-margin'],
    ['Breakeven', 'qc-breakeven'], ['Low rate annual', 'qc-low-annual'], ['Base rate annual', 'qc-base-annual'],
    ['High rate annual', 'qc-high-annual'],
  ];

  function qcSnapshot() {
    const inputs = {};
    for (const [k, id] of QC_INPUTS) {
      const v = $(id)?.value;
      inputs[k] = v === '' || v == null ? null : Number(v);
    }
    const results = {};
    for (const [k, id] of QC_RESULTS) {
      const t = $(id)?.textContent?.trim();
      if (t && t !== '—') results[k] = t;
    }
    return { inputs, results };
  }

  function qcSummary(snap) {
    const i = snap.inputs;
    const parts = [];
    if (i.beds != null) parts.push(`${i.beds} beds`);
    if (i.rate != null) parts.push(`$${i.rate}/bed`);
    if (i.occ != null) parts.push(`${i.occ}% occupancy`);
    if (snap.results.Verdict) parts.push(snap.results.Verdict);
    if (snap.results['Monthly cashflow']) parts.push(`${snap.results['Monthly cashflow']}/mo cashflow`);
    return parts.join(' · ');
  }

  function qcPanel(show) {
    $('qcSavePanel').hidden = !show;
    $('qcSaveDup').hidden = true;
    $('qcSaveStatus').textContent = '';
    if (show) $('qcSaveAddress').focus();
  }

  async function qcSave(how) {
    const status = $('qcSaveStatus');
    const address = $('qcSaveAddress').value.trim();
    if (!address) { status.textContent = 'Enter the address of the home'; return; }
    const id = await uid();
    if (!how) {
      const { data: dup, error } = await sb.from('reports').select('id').eq('user_id', id)
        .eq('bucket', 'projections').ilike('title', address.replace(/[%_]/g, '\\$&')).limit(1);
      if (error) { status.textContent = 'Not saved, check connection and try again'; return; }
      if (dup?.length) { $('qcSaveDup').hidden = false; $('qcSaveDup').dataset.id = dup[0].id; status.textContent = ''; return; }
      how = 'new';
    }
    const snap = qcSnapshot();
    const row = {
      title: address.slice(0, 200), summary: qcSummary(snap), bucket: 'projections', source: 'calculator',
      details: { ...snap, flags: { staffEdited: !!window.qcFlags?.get().staff, lowEdited: !!window.qcFlags?.get().low, highEdited: !!window.qcFlags?.get().high } },
      updated_at: new Date().toISOString(),
    };
    status.textContent = 'Saving...';
    const q = how === 'replace'
      ? sb.from('reports').update(row).eq('user_id', id).eq('id', $('qcSaveDup').dataset.id).select('id')
      : sb.from('reports').insert({ ...row, user_id: id }).select('id');
    const { data: written, error } = await q;
    // An update that matched nothing is not a save; never say "Saved" for it.
    if (error || !written?.length) {
      console.warn('[reports] projection save failed:', error?.message || 'no row written');
      status.textContent = 'Not saved, check connection and try again'; return;
    }
    $('qcSaveDup').hidden = true;
    status.textContent = `Saved ✓ in Reports → Projections as "${address}"`;
    if (loaded) load();
  }

  function loadIntoCalc() {
    const r = reports.find((x) => x.id === openId);
    const inputs = r?.details?.inputs;
    if (!inputs) return;
    for (const [k, id] of QC_INPUTS) if ($(id) && inputs[k] != null) $(id).value = inputs[k];
    const f = r.details.flags || {};
    window.qcFlags?.set({ staff: f.staffEdited ?? true, low: f.lowEdited ?? true, high: f.highEdited ?? true });
    closeDetail();
    document.querySelector('.tab[onclick*="quickcalc"]').click();
    if (typeof window.renderQuickCalc === 'function') window.renderQuickCalc();
    $('qcSaveAddress').value = r.title;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wire() {
    $('rpChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.rp-chip');
      if (!chip) return;
      filter.bucket = chip.dataset.bucket;
      render();
    });
    $('rpHome').addEventListener('change', (e) => { filter.home = e.target.value; render(); });
    $('rpPerson').addEventListener('change', (e) => { filter.person = e.target.value; render(); });
    $('rpFrom').addEventListener('change', (e) => { filter.from = e.target.value; render(); });
    $('rpTo').addEventListener('change', (e) => { filter.to = e.target.value; render(); });
    $('rpList').addEventListener('click', (e) => {
      const card = e.target.closest('.rp-card');
      if (card) openDetail(card.dataset.id);
    });
    $('rpDetail').addEventListener('click', (e) => {
      const t = e.target;
      if (t === $('rpDetail') || t.closest('.rp-close')) closeDetail();
      else if (t.closest('.rp-edit')) { mode = 'edit'; flash = ''; renderDetail(); }
      else if (t.closest('.rp-edit-cancel')) { mode = 'view'; renderDetail(); }
      else if (t.closest('#rpEditSave')) saveEdit();
      else if (t.closest('.rp-delete')) { mode = 'confirm-delete'; renderDetail(); }
      else if (t.closest('.rp-delete-cancel')) { mode = 'view'; renderDetail(); }
      else if (t.closest('.rp-delete-confirm')) deleteOpen();
      else if (t.closest('.rp-print')) printOpen();
      else if (t.closest('.rp-load-calc')) loadIntoCalc();
      else if (t.closest('.rp-roster-apply')) decideRoster('approve');
      else if (t.closest('.rp-roster-reject')) decideRoster('reject');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) closeDetail(); });
    $('rpNewBtn').addEventListener('click', () => toggleNew($('rpNewForm').hidden));
    $('rpNewCancel').addEventListener('click', () => toggleNew(false));
    $('rpNewSave').addEventListener('click', saveNew);

    $('anBtn').addEventListener('click', () => anOpen(true));
    $('anCancel').addEventListener('click', () => anOpen(false));
    $('anPanel').addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox]')) anPreview(); });
    $('anSend').addEventListener('click', anAsk);
    $('anConfirmYes').addEventListener('click', anSend);
    $('anConfirmNo').addEventListener('click', () => { $('anConfirm').hidden = true; });
    $('qcSaveReportBtn').addEventListener('click', () => qcPanel(true));
    $('qcSaveCancel').addEventListener('click', () => qcPanel(false));
    $('qcSaveConfirm').addEventListener('click', () => qcSave());
    $('qcSaveReplace').addEventListener('click', () => qcSave('replace'));
    $('qcSaveKeepBoth').addEventListener('click', () => qcSave('new'));
  }

  async function open() {
    await subscribe();
    await load();
  }

  function init() { wire(); }

  window.reports = { init, open };
})();
