// lib/team.js
// Organization profile + Team page (plans/sms-reports.md, step 1).
//
// Data lives in three tables from migration 003: org_profiles, team_roles,
// team_members. Every query names the signed-in user's id explicitly; RLS is
// the safety net, not the strategy (.claude/rules/auth.md).
//
// A person added here is 'pending' until their own phone replies YES. The
// database refuses to let the dashboard set anyone 'active', so nothing in this
// file tries to.
//
// Exposes window.team = { init(session), open() } and window.orgName.

(function () {
  const sb = window._supabase;

  // Every row lists every column: a bulk insert fills a column missing from some
  // rows with null, which the NOT NULL permission columns reject.
  const DEFAULT_ROLES = [
    { name: 'Owner', sort_order: 0, can_file_reports: true, can_approve_roster: true,
      can_log_rent: true, can_announce: true, can_request_intake: true, daily_report_required: false,
      notify_all_reports: true },
    { name: 'Operations Manager', sort_order: 1, can_file_reports: true, can_approve_roster: true,
      can_log_rent: true, can_announce: true, can_request_intake: true, daily_report_required: false,
      notify_all_reports: true },
    { name: 'House Manager', sort_order: 2, can_file_reports: true, can_approve_roster: false,
      can_log_rent: true, can_announce: false, can_request_intake: false, daily_report_required: true,
      notify_all_reports: false },
  ];

  const PERMS = [
    ['can_file_reports', 'File reports'],
    ['can_approve_roster', 'Approve move-ins/outs'],
    ['can_log_rent', 'Log rent'],
    ['can_announce', 'Send announcements'],
    ['can_request_intake', 'Request intake links'],
    ['daily_report_required', 'Must send a daily report'],
    ['notify_all_reports', 'Texted about every report'],
  ];

  const RULE_BUCKETS = [
    ['', 'Any report'], ['incidents', 'Incidents'], ['maintenance', 'Maintenance'], ['cleanings', 'Cleanings'],
    ['move_ins_outs', 'Move-ins/outs'], ['inventory', 'Inventory'], ['projections', 'Projections'],
    ['announcements', 'Announcements'],
  ];
  let rules = [];

  const STATUS_LABEL = {
    pending: 'Pending YES',
    active: 'Active',
    declined: 'Declined',
    blocked: 'Blocked',
    requested: 'Asked to join',
  };

  let roles = [];
  let members = [];
  let editingId = null;   // member being edited in the form, or null when adding
  // Homes picked in the form: "All homes", or a set of home ids.
  let pickAll = true;
  let picked = new Set();
  let rolesReady = null;  // promise: default roles seeded + loaded once per page

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function uid() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.id || null;
  }

  // ── Phone numbers ───────────────────────────────────────────────────────────
  // US only for now. Accepts any punctuation; stores +1XXXXXXXXXX.
  function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10 || !/[2-9]/.test(d[0])) return null;
    return '+1' + d;
  }
  function formatPhone(e164) {
    const d = String(e164 || '').replace(/^\+1/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
  }

  // ── Organization name ──────────────────────────────────────────────────────
  function showOrgName(name) {
    window.orgName = name || '';
    const sub = $('brandSub');
    if (sub) sub.textContent = name || 'Operations Dashboard';
    document.title = name ? `HouseBoss.AI · ${name}` : 'HouseBoss.AI';
  }

  // A join-code tap can land while a profile load is still in flight (the tab
  // reloads it on every open). setJoin waits for that load, and bumps joinEpoch so
  // a load that started before the tap can't put the old on/off state back.
  let orgLoad = null;
  let joinEpoch = 0;
  function loadOrgName() {
    orgLoad = readOrgProfile();
    return orgLoad;
  }
  async function readOrgProfile() {
    const epoch = joinEpoch;
    const id = await uid();
    if (!id) return;
    const { data, error } = await sb.from('org_profiles').select('org_name, reminder_hour, escalation_hour, join_code, join_enabled').eq('user_id', id).maybeSingle();
    if (error) { console.warn('[team] org name load failed:', error.message); return; }
    showOrgName(data?.org_name || '');
    const input = $('orgNameInput');
    if (input && document.activeElement !== input) input.value = data?.org_name || '';
    if ($('orgReminderHour')) $('orgReminderHour').value = String(data?.reminder_hour ?? 21);
    if ($('orgEscalationHour')) $('orgEscalationHour').value = String(data?.escalation_hour ?? 8);
    if (epoch === joinEpoch) {
      joinCode = data?.join_code || null;
      joinEnabled = !!data?.join_enabled;
    }
    if ($('jcState')) renderJoin();
  }

  async function saveOrgName() {
    const input = $('orgNameInput');
    const status = $('orgNameStatus');
    const name = input.value.trim();
    if (!name) { status.textContent = 'Enter a name first'; status.dataset.state = 'error'; return; }
    status.textContent = 'Saving...'; status.dataset.state = 'saving';
    const id = await uid();
    const { error } = await sb.from('org_profiles')
      .upsert({
        user_id: id, org_name: name, updated_at: new Date().toISOString(),
        reminder_hour: Number($('orgReminderHour').value),
        escalation_hour: Number($('orgEscalationHour').value),
        // Texts are dated in the operator's local time ("today", "this month").
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
      }, { onConflict: 'user_id' });
    if (error) {
      status.textContent = 'Not saved, check connection and try again'; status.dataset.state = 'error';
      return;
    }
    status.textContent = 'Saved ✓'; status.dataset.state = 'saved';
    showOrgName(name);
  }

  // ── Roles ──────────────────────────────────────────────────────────────────
  async function loadRoles() {
    const id = await uid();
    const { data, error } = await sb.from('team_roles').select('*').eq('user_id', id)
      .order('sort_order').order('created_at');
    if (error) throw error;
    roles = data || [];
  }

  async function ensureRoles() {
    await loadRoles();
    if (roles.length) return;
    const id = await uid();
    // Two tabs opening at once would both seed; the unique (user_id, name) key
    // makes the second a no-op instead of an error.
    const { error } = await sb.from('team_roles')
      .upsert(DEFAULT_ROLES.map((r) => ({ ...r, user_id: id })),
        { onConflict: 'user_id,name', ignoreDuplicates: true });
    if (error) throw error;
    await loadRoles();
  }

  async function setRolePerm(roleId, perm, value) {
    const id = await uid();
    const { error } = await sb.from('team_roles').update({ [perm]: value }).eq('user_id', id).eq('id', roleId);
    if (error) { roleMsg('Not saved, check connection'); await loadRoles(); }
    else roleMsg('Saved ✓');
    renderRoles();
  }

  async function addRole() {
    const input = $('roleNewName');
    const name = input.value.trim();
    if (!name) return;
    if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) { roleMsg('That role already exists'); return; }
    const id = await uid();
    const { error } = await sb.from('team_roles').insert({
      user_id: id, name, sort_order: roles.length,
      can_file_reports: true, can_approve_roster: false, can_log_rent: false,
      can_announce: false, can_request_intake: false, daily_report_required: false,
      notify_all_reports: false,
    });
    if (error) { roleMsg('Not saved, check connection'); return; }
    input.value = '';
    roleMsg('Saved ✓');
    await loadRoles();
    renderAll();
  }

  async function deleteRole(roleId) {
    if (members.some((m) => m.role_id === roleId)) {
      roleMsg('Someone still has this role. Change their role first.');
      return;
    }
    const id = await uid();
    const { error } = await sb.from('team_roles').delete().eq('user_id', id).eq('id', roleId);
    if (error) { roleMsg('Not removed, check connection'); return; }
    roleMsg('Removed ✓');
    await loadRoles();
    renderAll();
  }

  function roleMsg(text) { const el = $('roleMsg'); if (el) el.textContent = text; }

  // ── Members ────────────────────────────────────────────────────────────────
  async function loadMembers() {
    const id = await uid();
    const { data, error } = await sb.from('team_members').select('*').eq('user_id', id).order('created_at');
    if (error) throw error;
    members = data || [];
  }

  function formValues() {
    const allHomes = pickAll || picked.size === 0;
    return {
      name: $('tmName').value.trim(),
      phone: normalizePhone($('tmPhone').value),
      role_id: $('tmRole').value,
      all_homes: allHomes,
      home_ids: allHomes ? [] : [...picked],
      reports_to: $('tmReportsTo').value || null,
    };
  }

  function formError(text) { $('tmError').textContent = text || ''; }

  async function submitMember() {
    const v = formValues();
    if (!v.name) return formError('Enter their name.');
    if (!v.phone) return formError('Enter a 10-digit US phone number, e.g. (555) 201-3344.');
    if (!v.role_id) return formError('Pick a role.');
    const clash = members.find((m) => m.phone === v.phone && m.id !== editingId);
    if (clash) return formError(`That phone number is already on your team (${clash.name}).`);
    formError('');

    const btn = $('tmAdd');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    const id = await uid();
    const before = editingId ? members.find((m) => m.id === editingId) : null;
    const q = editingId
      ? sb.from('team_members').update(v).eq('user_id', id).eq('id', editingId).select('id, status').single()
      : sb.from('team_members').insert({ ...v, user_id: id }).select('id, status').single();
    const { data: saved, error } = await q;
    btn.disabled = false;
    if (error) {
      btn.textContent = editingId ? 'Save changes' : 'Add person';
      return formError('Not saved, check connection and try again. Nothing was lost; your entry is still here.');
    }
    resetForm();
    await loadMembers();
    renderAll();
    showForm(false);
    // New person, or a changed phone number: the (new) phone has to say YES.
    if (!before || before.phone !== v.phone) await sendInvite(saved.id);
  }

  // Asks the server to text the "Reply YES to join" invite. The result shows on
  // the person's card; failing to text never undoes adding them.
  async function sendInvite(memberId) {
    const show = (text, ok) => {
      const el = document.querySelector(`.tm-card[data-id="${memberId}"] .tm-invite-msg`);
      if (el) { el.textContent = text; el.dataset.ok = ok ? '1' : '0'; }
    };
    show('Sending invite text...', true);
    const { data, error } = await sb.functions.invoke('team-invite', { body: { member_id: memberId } });
    if (error) {
      let msg = 'Invite text not sent.';
      try { msg = (await error.context.json()).error || msg; } catch (_) {}
      show(msg, false);
    } else if (data?.ok) show('Invite text sent ✓ Waiting for them to reply YES.', true);
  }

  // The form stays tucked away behind "＋ Add person" once there's a team; with
  // nobody on it yet, it's the obvious next step, so it's simply open.
  function teamCount() { return members.filter((m) => m.status !== 'requested').length; }
  function showForm(open) {
    $('tmFormPanel').hidden = !open && teamCount() > 0;
    $('tmOpenForm').hidden = !$('tmFormPanel').hidden;
    $('tmCancel').hidden = teamCount() === 0;
  }

  function resetForm() {
    editingId = null;
    $('tmName').value = '';
    $('tmPhone').value = '';
    pickAll = true;
    picked = new Set();
    $('tmReportsTo').value = '';
    $('tmAdd').textContent = 'Add person';
    $('tmFormTitle').textContent = 'Add a person';
    formError('');
    renderHomesPicker();
  }

  function startEdit(memberId) {
    const m = members.find((x) => x.id === memberId);
    if (!m) return;
    editingId = m.id;
    $('tmName').value = m.name;
    $('tmPhone').value = formatPhone(m.phone);
    $('tmRole').value = m.role_id;
    pickAll = m.all_homes;
    picked = new Set((m.home_ids || []).map(Number));
    renderReportsTo();
    $('tmReportsTo').value = m.reports_to || '';
    renderHomesPicker();
    $('tmAdd').textContent = 'Save changes';
    $('tmFormTitle').textContent = `Edit ${m.name}`;
    formError('');
    showForm(true);
    $('tmName').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function removeMember(memberId) {
    const id = await uid();
    const { error } = await sb.from('team_members').delete().eq('user_id', id).eq('id', memberId);
    if (error) { formError('Not removed, check connection and try again.'); return; }
    if (editingId === memberId) resetForm();
    await loadMembers();
    renderAll();
  }

  // ── Notification rules ────────────────────────────────────────────────────
  async function loadRules() {
    const id = await uid();
    const { data, error } = await sb.from('notification_rules').select('*').eq('user_id', id).order('created_at');
    if (error) throw error;
    rules = data || [];
  }

  async function addRule() {
    const memberId = $('nrMember').value;
    if (!memberId) { $('nrMsg').textContent = 'Pick a person first.'; return; }
    const bucket = $('nrBucket').value || null;
    const homeId = $('nrHome').value === '' ? null : Number($('nrHome').value);
    if (rules.some((r) => r.member_id === memberId && r.bucket === bucket && r.home_id === homeId)) {
      $('nrMsg').textContent = 'That rule already exists.'; return;
    }
    const id = await uid();
    const { error } = await sb.from('notification_rules').insert({ user_id: id, bucket, home_id: homeId, member_id: memberId });
    if (error) { $('nrMsg').textContent = 'Not saved, check connection and try again'; return; }
    $('nrMsg').textContent = 'Saved ✓';
    await loadRules();
    renderRules();
  }

  async function removeRule(ruleId) {
    const id = await uid();
    const { error } = await sb.from('notification_rules').delete().eq('user_id', id).eq('id', ruleId);
    if (error) { $('nrMsg').textContent = 'Not removed, check connection'; return; }
    $('nrMsg').textContent = 'Removed ✓';
    await loadRules();
    renderRules();
  }

  function renderRules() {
    const keepB = $('nrBucket').value, keepH = $('nrHome').value, keepM = $('nrMember').value;
    $('nrBucket').innerHTML = RULE_BUCKETS.map(([k, t]) => `<option value="${k}">${t}</option>`).join('');
    $('nrHome').innerHTML = '<option value="">Any home</option>' +
      homeList().map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
    $('nrMember').innerHTML = '<option value="">Pick a person</option>' +
      members.filter((m) => m.status !== 'requested').map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('nrBucket').value = keepB; $('nrHome').value = keepH;
    $('nrMember').value = members.some((m) => m.id === keepM) ? keepM : '';
    const bucketName = (b) => (RULE_BUCKETS.find(([k]) => k === (b || '')) || ['', b])[1];
    const homeName = (h) => (h == null ? 'any home' : homeList().find((x) => Number(x.id) === h)?.name || `home ${h}`);
    $('nrList').innerHTML = rules.length ? rules.map((r) => {
      const who = members.find((m) => m.id === r.member_id)?.name || 'Someone removed';
      return `<div class="nr-row" data-id="${esc(r.id)}">
        <span><b>${esc(who)}</b> gets ${esc(bucketName(r.bucket).toLowerCase())} at ${esc(homeName(r.home_id))}</span>
        <button class="btn btn-red nr-remove" type="button">Remove</button></div>`;
    }).join('') : '';
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function homeList() { return Array.isArray(window.homes) ? window.homes : []; }

  function renderRoleSelect() {
    const sel = $('tmRole');
    const keep = sel.value;
    sel.innerHTML = roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    if (roles.some((r) => r.id === keep)) sel.value = keep;
    else {
      const hm = roles.find((r) => r.name === 'House Manager');
      if (hm) sel.value = hm.id;
    }
  }

  function renderReportsTo() {
    const sel = $('tmReportsTo');
    const keep = sel.value;
    sel.innerHTML = '<option value="">No one</option>' + members
      .filter((m) => m.id !== editingId && m.status !== 'requested')
      .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    sel.value = members.some((m) => m.id === keep) ? keep : '';
  }

  // One tap per home. "All homes" and specific homes are exclusive; un-picking the
  // last home falls back to All homes, so a person can never end up with none.
  function renderHomesPicker() {
    const chip = (key, label, on) =>
      `<button type="button" class="tm-chip" data-home="${esc(key)}" aria-pressed="${on}">${esc(label)}</button>`;
    $('tmHomes').innerHTML = chip('all', 'All homes', pickAll) +
      homeList().map((h) => chip(h.id, h.name, !pickAll && picked.has(Number(h.id)))).join('');
  }

  function toggleHome(key) {
    if (key === 'all') { pickAll = true; picked.clear(); }
    else {
      const id = Number(key);
      if (pickAll) { pickAll = false; picked = new Set([id]); }
      else if (picked.has(id)) picked.delete(id);
      else picked.add(id);
      if (!picked.size) pickAll = true;
    }
    renderHomesPicker();
  }

  function homesText(m) {
    if (m.all_homes) return 'All homes';
    const names = (m.home_ids || []).map((hid) => homeList().find((h) => Number(h.id) === Number(hid))?.name).filter(Boolean);
    return names.length ? names.join(', ') : 'No homes';
  }

  function renderMembers() {
    const list = $('teamList');
    const team = members.filter((m) => m.status !== 'requested');
    renderRequests();
    if (!team.length) {
      list.innerHTML = '<div class="tm-note">No one yet. Add yourself first, then your managers.</div>';
      showForm(true);
      return;
    }
    if (!editingId && $('tmFormPanel').hidden === false && !$('tmName').value) showForm(false);
    list.innerHTML = team.map((m) => {
      const role = roles.find((r) => r.id === m.role_id)?.name || '';
      const boss = members.find((x) => x.id === m.reports_to)?.name;
      return `
        <div class="tm-card tm-person" data-id="${esc(m.id)}">
          <div class="tm-person-main">
            <span class="tm-name">${esc(m.name)}</span>
            <span class="tm-status tm-status-${esc(m.status)}">${esc(STATUS_LABEL[m.status] || m.status)}</span>
          </div>
          <div class="tm-meta">
            <span class="tm-phone">${esc(formatPhone(m.phone))}</span>
            <span>${esc(role)}</span>
            <span>${esc(homesText(m))}</span>
            ${boss ? `<span>Reports to ${esc(boss)}</span>` : ''}
          </div>
          <div class="tm-invite-msg" aria-live="polite"></div>
          <div class="tm-links">
            ${m.status === 'pending' ? '<button class="tm-link tm-resend" type="button">Resend invite</button>' : ''}
            <button class="tm-link tm-edit" type="button">Edit</button>
            <button class="tm-link tm-link-red tm-remove" type="button">Remove</button>
            <button class="tm-link tm-link-red tm-remove-confirm" type="button" hidden>Yes, remove</button>
            <button class="tm-link tm-remove-cancel" type="button" hidden>Keep</button>
          </div>
        </div>`;
    }).join('');
  }

  // ── Join code + requests ─────────────────────────────────────────────────
  let joinCode = null;
  let joinEnabled = false;

  function renderJoin() {
    $('jcState').innerHTML = joinEnabled && joinCode
      ? `Join code on: staff text <b>JOIN ${esc(joinCode)} Their Name</b> to 1-888-267-7502; requests show at the top of Team.`
      : 'Join code off: people join only when you add them.';
    $('jcOn').hidden = joinEnabled;
    $('jcNew').hidden = !joinEnabled;
    $('jcOff').hidden = !joinEnabled;
  }

  function makeCode() {
    // First word of the org name: "Sunrise Homes" -> SUNRISE-4821.
    const firstWord = (window.orgName || '').trim().split(/\s+/)[0] || '';
    const prefix = firstWord.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'TEAM';
    return `${prefix}-${String(Math.floor(1000 + Math.random() * 9000))}`;
  }

  async function setJoin(enabled, fresh) {
    joinEpoch++;
    if (orgLoad) await orgLoad.catch(() => {});
    const id = await uid();
    if (!window.orgName) { $('jcMsg').textContent = 'Save your organization name first.'; return; }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = fresh || !joinCode ? makeCode() : joinCode;
      const { error } = await sb.from('org_profiles').update({ join_code: code, join_enabled: enabled }).eq('user_id', id);
      if (!error) { joinCode = code; joinEnabled = enabled; $('jcMsg').textContent = 'Saved ✓'; renderJoin(); return; }
      if (!/duplicate|unique/i.test(error.message)) break; // code taken: try another
    }
    $('jcMsg').textContent = 'Not saved, check connection and try again.';
  }

  function renderRequests() {
    const reqs = members.filter((m) => m.status === 'requested');
    $('jrList').innerHTML = reqs.length ? reqs.map((m) => `
      <div class="tm-card jr-card" data-id="${esc(m.id)}">
        <div class="tm-card-top"><div><div class="tm-name">${esc(m.name)}</div><div class="tm-phone">${esc(formatPhone(m.phone))}</div></div>
          <span class="tm-status tm-status-pending">Asked to join</span></div>
        <div class="tm-actions">
          <select class="tm-select jr-role" aria-label="Role for ${esc(m.name)}">${roles.map((r) =>
            `<option value="${esc(r.id)}" ${r.id === m.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
          <button class="btn btn-gold jr-approve" type="button">Approve</button>
          <button class="btn btn-red jr-decline" type="button">Decline</button>
        </div>
        <div class="tm-msg jr-msg" aria-live="polite"></div>
      </div>`).join('') : '';
    if (reqs.length) $('jrList').insertAdjacentHTML('afterbegin', `<div class="jr-head">Asked to join (${reqs.length})</div>`);
  }

  async function decideJoin(card, decision) {
    const msg = card.querySelector('.jr-msg');
    msg.textContent = decision === 'approve' ? 'Approving...' : 'Declining...';
    const { error } = await sb.functions.invoke('join-decide', {
      body: { member_id: card.dataset.id, decision, role_id: card.querySelector('.jr-role')?.value },
    });
    if (error) { msg.textContent = 'Not saved, check connection and try again.'; return; }
    await loadMembers();
    renderAll();
  }

  // One grid: roles down the side, permissions across the top.
  function renderRoles() {
    const short = {
      can_file_reports: 'File reports', can_approve_roster: 'Approve move-ins/outs', can_log_rent: 'Log rent',
      can_announce: 'Announce', can_request_intake: 'Intake links', daily_report_required: 'Daily report',
      notify_all_reports: 'Every report',
    };
    $('roleList').innerHTML = `<thead><tr><th>Role</th>${PERMS.map(([key]) => `<th>${short[key]}</th>`).join('')}<th></th></tr></thead>
      <tbody>${roles.map((r) => `
        <tr class="tm-role" data-id="${esc(r.id)}">
          <td>${esc(r.name)}</td>
          ${PERMS.map(([key, label]) => `<td><input type="checkbox" data-perm="${key}" ${r[key] ? 'checked' : ''} aria-label="${esc(r.name)}: ${label}"></td>`).join('')}
          <td><button class="tm-role-x tm-role-delete" type="button" aria-label="Remove ${esc(r.name)} role" title="Remove role">✕</button></td>
        </tr>`).join('')}</tbody>`;
  }

  function renderAll() {
    renderRoleSelect();
    renderReportsTo();
    renderHomesPicker();
    renderMembers();
    renderRoles();
    renderRules();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wire() {
    $('orgNameSave').addEventListener('click', saveOrgName);
    $('orgNameInput').addEventListener('input', () => { $('orgNameStatus').textContent = ''; });
    $('tmAdd').addEventListener('click', submitMember);
    $('tmCancel').addEventListener('click', () => { resetForm(); showForm(false); });
    $('tmOpenForm').addEventListener('click', () => { resetForm(); showForm(true); $('tmName').focus(); });
    $('tmHomes').addEventListener('click', (e) => {
      const chip = e.target.closest('.tm-chip');
      if (chip) toggleHome(chip.dataset.home);
    });
    $('roleAdd').addEventListener('click', addRole);
    $('nrAdd').addEventListener('click', addRule);
    $('jcOn').addEventListener('click', () => setJoin(true, false));
    $('jcNew').addEventListener('click', () => setJoin(true, true));
    $('jcOff').addEventListener('click', () => setJoin(false, false));
    $('jrList').addEventListener('click', (e) => {
      const card = e.target.closest('.jr-card');
      if (!card) return;
      if (e.target.closest('.jr-approve')) decideJoin(card, 'approve');
      else if (e.target.closest('.jr-decline')) decideJoin(card, 'decline');
    });
    $('nrList').addEventListener('click', (e) => {
      const row = e.target.closest('.nr-row');
      if (row && e.target.closest('.nr-remove')) removeRule(row.dataset.id);
    });

    $('teamList').addEventListener('click', (e) => {
      const card = e.target.closest('.tm-card');
      if (!card) return;
      const show = (sel, on) => { card.querySelector(sel).hidden = !on; };
      if (e.target.closest('.tm-resend')) sendInvite(card.dataset.id);
      else if (e.target.closest('.tm-edit')) startEdit(card.dataset.id);
      else if (e.target.closest('.tm-remove')) {
        show('.tm-remove', false); show('.tm-edit', false);
        show('.tm-remove-confirm', true); show('.tm-remove-cancel', true);
      } else if (e.target.closest('.tm-remove-cancel')) {
        show('.tm-remove', true); show('.tm-edit', true);
        show('.tm-remove-confirm', false); show('.tm-remove-cancel', false);
      } else if (e.target.closest('.tm-remove-confirm')) removeMember(card.dataset.id);
    });

    $('roleList').addEventListener('change', (e) => {
      const box = e.target.closest('input[data-perm]');
      const row = e.target.closest('.tm-role');
      if (box && row) setRolePerm(row.dataset.id, box.dataset.perm, box.checked);
    });
    $('roleList').addEventListener('click', (e) => {
      const row = e.target.closest('.tm-role');
      if (row && e.target.closest('.tm-role-delete')) deleteRole(row.dataset.id);
    });
  }

  async function open() {
    try {
      if (!rolesReady) rolesReady = ensureRoles();
      await rolesReady;
      await loadMembers();
      await loadRules();
      await loadOrgName();
      renderAll();
    } catch (e) {
      rolesReady = null; // let the next open retry
      console.warn('[team] load failed:', e);
      $('teamList').innerHTML = '<div class="tm-empty">Couldn\'t load your team. Check your connection and reopen this tab.</div>';
    }
  }

  async function init() {
    wire();
    await loadOrgName();
  }

  window.team = { init, open, normalizePhone, formatPhone };
})();
