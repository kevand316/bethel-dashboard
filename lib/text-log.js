// lib/text-log.js
// Text Log on the Reports tab: every text in and out of the account's number,
// grouped by person, newest conversation first. Shows replies the carrier did not
// deliver too, so a conversation can be followed from the dashboard while outbound
// texts are blocked (toll-free verification pending) or when a phone misses one.
//
// Read-only. sms_messages is written only by the server; RLS lets an owner read
// their own rows, and every query here names the signed-in user's id as well.
// While the panel is open it refreshes every few seconds.
//
// Exposes window.textLog = { init() }.

(function () {
  const sb = window._supabase;
  const REFRESH_MS = 4000;
  const LIMIT = 500;

  let timer = null;
  let lastKey = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function uid() {
    const { data: { session } } = await sb.auth.getSession();
    return session?.user?.id || null;
  }

  function when(iso) {
    const d = new Date(iso);
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleString('en-US', opts);
  }
  function phone(e164) {
    const d = String(e164 || '').replace(/^\+1/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (e164 || '');
  }

  // What happened to a text we sent. Twilio's statuses, in plain words.
  function outcome(m) {
    if (m.status === 'delivered') return ['Delivered', ''];
    if (m.status === 'test') return ['Test number, not sent', ''];
    if (m.status === 'failed' || m.status === 'undelivered') return ['Not delivered', 'tl-bad'];
    return ['Sent', ''];
  }

  async function load() {
    const id = await uid();
    if (!id) return;
    const [msgs, team] = await Promise.all([
      sb.from('sms_messages').select('id, direction, phone, body, status, media_count, created_at')
        .eq('user_id', id).order('created_at', { ascending: false }).limit(LIMIT),
      sb.from('team_members').select('name, phone').eq('user_id', id),
    ]);
    if (msgs.error) {
      $('tlList').innerHTML = '<div class="tm-empty">Couldn\'t load texts. Check your connection.</div>';
      return;
    }
    const rows = msgs.data || [];
    // Skip the redraw when nothing changed, so scrolling isn't disturbed.
    const key = rows.map((m) => m.id + m.status).join();
    if (key === lastKey) return;
    lastKey = key;
    render(rows, new Map((team.data || []).map((t) => [t.phone, t.name])));
  }

  function render(rows, names) {
    if (!rows.length) {
      $('tlList').innerHTML = '<div class="tm-empty">No texts yet. Texts to and from 1-888-267-7502 will show here.</div>';
      return;
    }
    // rows are newest first, so threads come out newest-conversation first.
    const threads = new Map();
    for (const m of rows) {
      if (!threads.has(m.phone)) threads.set(m.phone, []);
      threads.get(m.phone).push(m);
    }
    $('tlList').innerHTML = [...threads].map(([num, list]) => {
      const name = names.get(num);
      const msgs = list.slice().reverse().map((m) => {
        const out = m.direction === 'out';
        const [what, cls] = out ? outcome(m) : ['', ''];
        const photos = m.media_count ? ` · ${m.media_count} photo${m.media_count > 1 ? 's' : ''}` : '';
        return `<div class="rp-msg ${out ? 'rp-msg-out' : 'rp-msg-in'}">${esc(m.body)}
          <div class="tl-stamp">${esc(when(m.created_at))}${photos}${what ? ` · <span class="${cls}">${what}</span>` : ''}</div></div>`;
      }).join('');
      return `<div class="tl-thread">
        <div class="tl-who">${name ? `${esc(name)} <span>${esc(phone(num))}</span>` : esc(phone(num))}</div>
        <div class="rp-convo">${msgs}</div></div>`;
    }).join('');
  }

  function show(on) {
    $('tlPanel').hidden = !on;
    clearInterval(timer);
    timer = null;
    if (!on) return;
    lastKey = null;
    $('tlList').innerHTML = '<div class="tm-empty">Loading…</div>';
    load();
    timer = setInterval(() => { if (!document.hidden && !$('tlPanel').hidden) load(); }, REFRESH_MS);
  }

  function init() {
    $('tlBtn').addEventListener('click', () => show($('tlPanel').hidden));
    $('tlClose').addEventListener('click', () => show(false));
  }

  window.textLog = { init };
})();
