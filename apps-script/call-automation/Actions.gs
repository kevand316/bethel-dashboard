/** Actions.gs: emails (Gmail drafts) and reminders (Calendar) for what staff promised on the call. */
function runActions_(call, actions, ctx) {
  const done = [];
  actions.forEach(function (a, i) {
    const key = call.id + ':a' + i;
    if (stepDone_(key)) { done.push('(already done) ' + (a.subject || a.title || a.reason)); return; }
    if (!inTranscript_(a.quote, call.text)) { done.push('Skipped, not supported by the transcript: ' + a.reason); return; }
    if (a.kind === 'email') done.push(createEmail_(a, ctx));
    else if (a.kind === 'reminder') done.push(createReminder_(a, call));
    markStep_(key);
  });
  return done;
}

function createEmail_(a, ctx) {
  const to = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(a.to || '').trim()) ? String(a.to).trim() : '';
  const attachments = [];
  const missing = [];
  (a.documents || []).forEach(function (n) {
    const d = ctx.documents.filter(function (x) { return norm_(x.name) === norm_(n); })[0];
    if (d) attachments.push(DriveApp.getFileById(d.id).getBlob());
    else missing.push(n);
  });
  const subject = a.subject || 'Following up from our call';
  const html = escHtml_(a.body || '').replace(/\n/g, '<br>') + '<br><br>' + signature_(ctx);
  const draft = GmailApp.createDraft(to, subject, a.body || '', { htmlBody: html, attachments: attachments, name: ctx.settings.ORG_NAME });
  const auto = /^yes$/i.test(String(ctx.settings.AUTO_SEND_EMAILS || '')) && to;
  if (auto) draft.send();
  return (auto ? 'Email sent' : 'Email draft ready') + ': "' + subject + '" to ' + (to || '(no email heard on the call; add the recipient)') +
    (attachments.length ? ', ' + attachments.length + ' attachment(s)' : '') +
    (missing.length ? ' (not in the Documents tab: ' + missing.join(', ') + ')' : '');
}

/** Gmail drafts made by a script don't get the signature automatically. */
function signature_(ctx) {
  if (signature_.cache != null) return signature_.cache;
  try {
    signature_.cache = Gmail.Users.Settings.SendAs.get('me', ctx.settings.SENDER_EMAIL).signature || '';
  } catch (e) {
    console.warn('signature', e);
    signature_.cache = '';
  }
  return signature_.cache;
}

function createReminder_(a, call) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(a.when || ''))) throw new Error('Reminder time unreadable: ' + a.when);
  const start = Utilities.parseDate(a.when, TZ, "yyyy-MM-dd'T'HH:mm");
  const ev = CalendarApp.getDefaultCalendar().createEvent(a.title || a.reason, start, new Date(start.getTime() + 15 * 60000), {
    description: (a.notes ? a.notes + '\n\n' : '') + 'From the recorded call on ' + fmtTime_(call.when) + '.\nSaid on the call: "' + a.quote + '"',
  });
  ev.addPopupReminder(10);
  return 'Reminder set: ' + (a.title || a.reason) + ' (' + Utilities.formatDate(start, TZ, 'EEE M/d h:mm a') + ')';
}

/** One email to the staff member who took the call. */
function sendCallSummary_(call, out, ctx) {
  if (stepDone_(call.id + ':summary')) return;
  const to = call.owner || setting_('ALERT_EMAIL');
  const lines = [];
  if (out.client) {
    lines.push('Intake for ' + out.client + ': saved to HouseBoss → Intake, PDF emailed to the operations manager. HouseBoss: ' + out.houseboss + '.');
    if (out.stillNeed && out.stillNeed.length) lines.push('Still needed: ' + out.stillNeed.length + ' item(s), listed in the PDF.');
  }
  (out.actions || []).forEach(function (x) { lines.push(x); });
  if (!lines.length) return;
  GmailApp.sendEmail(to, 'From your call' + (out.otherParty ? ' with ' + out.otherParty : '') + ' (' + fmtTime_(call.when) + ')',
    lines.map(function (l) { return '• ' + l; }).join('\n') + '\n\nDrafts are in ' + ctx.settings.SENDER_EMAIL + ' → Drafts. Calls Log: ' + sheetUrl_(),
    { name: ctx.settings.ORG_NAME });
  markStep_(call.id + ':summary');
}
