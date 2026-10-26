/** Sheet.gs: the "HouseBoss Call Automation" spreadsheet (in info@'s Drive, not shared). */
const LOG_HEADERS = ['Call ID', 'Call time', 'Staff', 'Type', 'Other party', 'Client', 'Move-in', 'Home',
  'Result / actions', 'Intake file', 'PDF', 'Status', 'Attempts', 'Error', 'Processed at'];

function book_() { return SpreadsheetApp.openById(cfg('SHEET_ID')); }
function sheet_(name) {
  const s = book_().getSheetByName(name);
  if (!s) throw new Error('Missing tab "' + name + '" in the automation sheet');
  return s;
}
function sheetUrl_() { try { return book_().getUrl(); } catch (e) { return '(sheet not set up)'; } }

function readSettings_() {
  const out = {};
  sheet_('Settings').getDataRange().getValues().slice(1).forEach(function (r) {
    if (String(r[0]).trim()) out[String(r[0]).trim()] = String(r[1]).trim();
  });
  return out;
}
function setting_(key) { return readSettings_()[key] || ''; }

function readStaff_() {
  const out = {};
  sheet_('Staff').getDataRange().getValues().slice(1).forEach(function (r) {
    const email = String(r[0]).trim().toLowerCase();
    if (email) out[email] = { name: String(r[1]).trim() || email };
  });
  return out;
}

function readDocuments_() {
  return sheet_('Documents').getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) {
      const link = String(r[1]).trim();
      const id = (link.match(/\/d\/([\w-]{20,})/) || link.match(/[?&]id=([\w-]{20,})/) || [null, link])[1];
      return { name: String(r[0]).trim(), id: id, use: String(r[2] || '').trim() };
    });
}

function loadLog_() {
  const s = sheet_('Calls Log');
  const rows = s.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < rows.length; i++) index[rows[i][0]] = { row: i + 1, status: rows[i][11], attempts: Number(rows[i][12]) || 0 };
  return {
    isDone: function (id) { return !!index[id] && (index[id].status === 'done' || index[id].status === 'failed'); },
    attempts: function (id) { return index[id] ? index[id].attempts : 0; },
    write: function (call, r) {
      const staff = (readStaff_()[(call.owner || '').toLowerCase()] || {}).name || call.owner || '';
      const row = [call.id, fmtTime_(call.when), staff, r.type || '', r.otherParty || '', r.client || '',
        r.moveIn || '', r.home || '', [r.summary].concat(r.actions || []).filter(Boolean).join('\n'),
        r.intakeFileId ? 'https://drive.google.com/file/d/' + r.intakeFileId + '/view' : '', r.pdfUrl || '',
        r.status, r.attempts, r.error || '', fmtTime_(new Date())];
      if (index[call.id]) s.getRange(index[call.id].row, 1, 1, row.length).setValues([row]);
      else { s.appendRow(row); index[call.id] = { row: s.getLastRow(), status: r.status, attempts: r.attempts }; }
      index[call.id].status = r.status;
      index[call.id].attempts = r.attempts;
    },
  };
}
