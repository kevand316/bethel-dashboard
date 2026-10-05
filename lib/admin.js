// lib/admin.js
// Platform admin view (plans/sms-reports.md, step 8). The Admin tab only appears
// when the platform-admin Edge Function confirms the signed-in user is a platform
// admin; the server refuses everyone else, so hiding the tab is cosmetic.
//
// Exposes window.platformAdmin = { init(), open() }.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const money = (n) => '$' + Number(n || 0).toFixed(2);

  async function fetchData() {
    const { data, error } = await sb.functions.invoke('platform-admin', { body: {} });
    return error ? null : data;
  }

  async function init() {
    const data = await fetchData();
    if (data) $('adminTab').hidden = false;
  }

  async function open() {
    $('adBody').innerHTML = '<div class="tm-note">Loading...</div>';
    const d = await fetchData();
    if (!d) { $('adBody').innerHTML = '<div class="tm-empty">Couldn\'t load. Check your connection.</div>'; return; }
    const month = new Date(d.month_start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    $('adTotals').innerHTML = `
      <div class="rt-tot"><label>Accounts</label><span>${d.totals.accounts}</span></div>
      <div class="rt-tot"><label>Texting this month</label><span>${d.totals.texting_accounts}</span></div>
      <div class="rt-tot"><label>Texts in ${esc(month)}</label><span>${d.totals.texts.toLocaleString()}</span></div>
      <div class="rt-tot"><label>Est. texting + AI cost</label><span>${money(d.totals.est_cost)}</span></div>`;
    $('adBody').innerHTML = `
      <div class="ad-scroll"><table class="ad-table">
        <thead><tr><th>Account</th><th>Organization</th><th>Joined</th><th>Last sign-in</th><th>Team</th>
          <th>Reports</th><th>Texts in / out</th><th>Photos</th><th>Est. cost</th><th>Last text</th></tr></thead>
        <tbody>${d.accounts.map((a) => `
          <tr class="ad-row${a.textsIn + a.textsOut + a.active ? '' : ' ad-idle'}">
            <td>${esc(a.email)}</td><td>${esc(a.org_name || '—')}</td><td>${day(a.created_at)}</td><td>${day(a.last_sign_in_at)}</td>
            <td>${a.active}${a.pending ? ` (+${a.pending} pending)` : ''}</td><td>${a.reports}</td>
            <td class="ad-texts">${a.textsIn} / ${a.textsOut}</td><td>${a.photos}</td><td class="ad-cost">${money(a.est_cost)}</td>
            <td>${day(a.last)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <div class="tm-note">${esc(month)} so far. Cost is an estimate (${money(d.rates.sms)}/text, ${money(d.rates.mms)}/photo,
        ${money(d.rates.ai)}/AI reply); actual bills are in Twilio and Anthropic.</div>`;
  }

  window.platformAdmin = { init, open };
})();
