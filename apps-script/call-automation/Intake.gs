/** Intake.gs: build the HouseBoss intake record, save it where the Intake tab sees it, notify. */
function runIntake_(call, ai, ctx, hb) {
  const built = buildRecord_(ai.intakeFields || [], ctx.homes, call, ctx);
  const record = built.record;
  const checklist = applyRules_(record, ctx.rules);
  const stillNeed = INTAKE_FIELDS
    .filter(function (f) { return f.required && isBlank_(record[f.name]); })
    .map(function (f) { return 'Not captured on the call: ' + f.label; })
    .concat(built.flags);
  if (!record.moveInDate || !record.prefLocation) stillNeed.push('Move-in date or home not captured: HouseBoss was not notified. Add them in the Intake tab and tell the house manager.');

  const drive = new HbDrive_(hb.access_token);
  const folder = drive.folder();
  const base = fileBase_(record);
  const fileId = drive.saveIntake(folder, base + '.json', record, call.id);

  let pdfId = P.getProperty('STEP:' + call.id + ':pdf');
  const pdf = buildPdf_(record, { checklist: checklist, stillNeed: stillNeed, sources: built.sources, call: call, staff: ctx.staffName, org: ctx.settings.ORG_NAME }, base);
  if (!pdfId) {
    pdfId = drive.upload(folder, pdf, 'application/pdf');
    drive.upload(folder, Utilities.newBlob(transcriptText_(call, ctx), 'text/plain', base + ' — call transcript.txt'), 'text/plain');
    P.setProperty('STEP:' + call.id + ':pdf', pdfId);
  }
  if (!stepDone_(call.id + ':ops')) { emailOpsManager_(record, checklist, stillNeed, pdf, ctx); markStep_(call.id + ':ops'); }

  let houseboss = 'not sent (no move-in date or home)';
  if (record.moveInDate && record.prefLocation) {
    const r = hbCall_('move_in', {
      client_label: clientLabel_(record),
      home_name: record.prefLocation,
      move_in_date: record.moveInDate,
      drive_file_id: fileId,
      ops_manager_name: ctx.settings.OPS_MANAGER_NAME || '',
    });
    houseboss = r.already ? 'already notified' : 'notified (' + ((r.notified || []).length) + ' texts)';
  }
  return {
    client: [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unnamed intake',
    moveIn: record.moveInDate, home: record.prefLocation,
    intakeFileId: fileId, pdfUrl: 'https://drive.google.com/file/d/' + pdfId + '/view',
    checklist: checklist, stillNeed: stillNeed, houseboss: houseboss,
  };
}

function buildRecord_(aiFields, homes, call, ctx) {
  const record = {};
  INTAKE_FIELDS.forEach(function (f) { record[f.name] = f.type === 'check' ? [] : ''; });
  const byName = {};
  INTAKE_FIELDS.forEach(function (f) { byName[f.name] = f; });
  const flags = [];
  const sources = {};

  aiFields.forEach(function (a) {
    const f = byName[a.name];
    if (!f) return;
    if (!inTranscript_(a.quote, call.text)) { flags.push(f.label + ': answer could not be matched to the transcript. Confirm it.'); return; }
    const v = coerce_(f, a, homes);
    if (v.error) { flags.push(f.label + ': heard "' + v.error + '", which is not one of the form\'s choices. Confirm it.'); return; }
    if (isBlank_(v.value)) return;
    record[f.name] = v.value;
    sources[f.name] = a.quote;
  });

  record.intakeDate = Utilities.formatDate(call.when, TZ, 'yyyy-MM-dd');
  if (byName.callDateTime && !record.callDateTime) record.callDateTime = Utilities.formatDate(call.when, TZ, "yyyy-MM-dd'T'HH:mm");
  if (byName.staffName && !record.staffName) record.staffName = ctx.staffName;
  if (byName.intakeNotes) {
    record.intakeNotes = [record.intakeNotes, 'Filled automatically from the recorded call on ' + fmtTime_(call.when) +
      '. See the PDF for the checklist and anything still missing.'].filter(Boolean).join('\n\n');
  }
  return { record: record, flags: flags, sources: sources };
}

function coerce_(f, a, homes) {
  const raw = String(a.value == null ? '' : a.value).trim();
  const choices = f.dynamic === 'homes' ? homes : (f.options || []);
  const pick = function (s) {
    for (let i = 0; i < choices.length; i++) if (norm_(choices[i]) === norm_(s)) return choices[i];
    return null;
  };
  switch (f.type) {
    case 'check': {
      const vals = (a.values && a.values.length ? a.values : raw ? raw.split(/\s*[,;]\s*/) : []);
      const out = [];
      for (let i = 0; i < vals.length; i++) {
        const c = pick(vals[i]);
        if (!c) return { error: vals[i] };
        if (out.indexOf(c) < 0) out.push(c);
      }
      return { value: out };
    }
    case 'select':
    case 'radio': {
      if (!raw) return { value: '' };
      const c = pick(raw);
      return c ? { value: c } : { error: raw };
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : raw ? { error: raw } : { value: '' };
    case 'datetime-local':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? { value: raw } : raw ? { error: raw } : { value: '' };
    default:
      if (f.name === 'ssn' && raw) {
        const d = raw.replace(/\D/g, '');
        return d.length === 9 ? { value: d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) } : { error: 'incomplete SSN' };
      }
      return { value: raw };
  }
}

/** Same file name rule as lib/drive.js fileNameFor(), minus the extension. */
function fileBase_(record) {
  const who = [String(record.lastName || '').trim(), String(record.firstName || '').trim()].filter(Boolean).join(', ') || 'Unnamed intake';
  return who + (record.intakeDate ? ' — ' + record.intakeDate : '');
}

function clientLabel_(record) {
  const first = String(record.firstName || '').trim();
  const last = String(record.lastName || '').trim();
  return (first + (last ? ' ' + last[0].toUpperCase() + '.' : '')).slice(0, 40) || 'New resident';
}

function transcriptText_(call, ctx) {
  return 'Recorded call · ' + fmtTime_(call.when) + ' · Staff: ' + ctx.staffName +
    ' · Other number: ' + (call.counterpart || 'unknown') + '\n\n' + call.text;
}

function emailOpsManager_(record, checklist, stillNeed, pdf, ctx) {
  const to = String(ctx.settings.OPS_MANAGER_EMAIL || '').trim();
  if (!to) throw new Error('Settings: OPS_MANAGER_EMAIL is empty');
  const domain = '@' + String(ctx.settings.ORG_DOMAIN || '').toLowerCase();
  // Client details stay inside Google Workspace (BAA): never to a personal address.
  if (to.toLowerCase().slice(-domain.length) !== domain) throw new Error('OPS_MANAGER_EMAIL must be a ' + domain + ' address');
  const name = [record.firstName, record.lastName].filter(Boolean).join(' ') || 'New resident';
  const li = function (xs) { return xs.length ? '<ul>' + xs.map(function (x) { return '<li>' + escHtml_(x) + '</li>'; }).join('') + '</ul>' : '<p>None.</p>'; };
  const html =
    '<p><b>' + escHtml_(name) + '</b>' + (record.moveInDate ? ' moves in <b>' + fmtDate_(record.moveInDate) + '</b>' : '') +
    (record.prefLocation ? ' at <b>' + escHtml_(record.prefLocation) + '</b>' : '') + '.</p>' +
    '<p><b>Checklist</b></p>' + li(checklist) +
    '<p><b>Still needed</b></p>' + li(stillNeed) +
    '<p>The full intake is attached and is in HouseBoss → Intake.</p>';
  GmailApp.sendEmail(to, 'New intake: ' + name + (record.moveInDate ? ' (moves in ' + fmtDate_(record.moveInDate) + ')' : ''),
    'Open this email in Gmail to see the intake summary. The full intake PDF is attached.',
    { htmlBody: html, attachments: [pdf], name: ctx.settings.ORG_NAME });
}

function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
