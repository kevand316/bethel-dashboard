// lib/text-intake.js
// Intake tab → "Intake by text". One Google consent (offline access, drive.file)
// lets a texted "intake" link open this same intake form on a phone and save to
// this account's Drive. The refresh token stays on the server (Edge Function
// google-connect); only the email comes back here.
//
// Exposes window.textIntake = { init(), render() }.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // One Google consent lets a texted "intake" link save to this account's Drive.
  // The refresh token stays on the server; only the email comes back here.
  async function render() {
    const { data, error } = await sb.functions.invoke('google-connect', { body: { action: 'status' } });
    if (error) { $('tiState').textContent = 'Couldn\'t check, try again later.'; return; }
    $('tiState').innerHTML = data.connected
      ? `<b>On.</b> Texted intake links save to ${esc(data.email || 'your Google Drive')} (HouseBoss Intake Forms folder).`
      : 'Off. Turn it on and staff who text "intake" to the HouseBoss number get a one-time link to this form on their phone; it saves here, to your Drive.';
    $('tiOn').hidden = data.connected;
    $('tiOff').hidden = !data.connected;
  }

  function allow() {
    const msg = $('tiMsg');
    if (!window.google?.accounts?.oauth2 || !window.drive?.clientId) { msg.textContent = 'Google sign-in is still loading. Try again in a moment.'; return; }
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: window.drive.clientId,
      scope: window.drive.scope,
      ux_mode: 'popup',
      callback: async (resp) => {
        if (!resp.code) { msg.textContent = 'Google didn\'t allow it.'; return; }
        msg.textContent = 'Saving...';
        const { data, error } = await sb.functions.invoke('google-connect', { body: { action: 'connect', code: resp.code } });
        if (error) {
          let text = 'Not saved, try again.';
          try { text = (await error.context.json()).error || text; } catch (_) {}
          msg.textContent = text;
          return;
        }
        msg.textContent = `Saved ✓ Texted intakes save to ${data.email || 'your Drive'}.`;
        render();
      },
      error_callback: () => { msg.textContent = 'Google window was closed.'; },
    });
    client.requestCode();
  }

  async function disallow() {
    $('tiMsg').textContent = 'Turning off...';
    const { error } = await sb.functions.invoke('google-connect', { body: { action: 'disconnect' } });
    $('tiMsg').textContent = error ? 'Not saved, try again.' : 'Turned off ✓';
    render();
  }


  function init() {
    $('tiOn').addEventListener('click', allow);
    $('tiOff').addEventListener('click', disallow);
  }

  window.textIntake = { init, render };
})();
