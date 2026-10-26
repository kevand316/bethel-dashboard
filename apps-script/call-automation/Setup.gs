/** Setup.gs: run setup() once, then checkSetup(). */
function setup() {
  if (!P.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('HouseBoss Call Automation');
    P.setProperty('SHEET_ID', ss.getId());
    const first = ss.getSheets()[0];
    first.setName('Settings');
    first.getRange(1, 1, 7, 2).setValues([
      ['Setting', 'Value'],
      ['ORG_NAME', 'Bethel Residency'],
      ['ORG_DOMAIN', 'bethelresidency.com'],
      ['SENDER_EMAIL', 'info@bethelresidency.com'],
      ['OPS_MANAGER_EMAIL', ''],
      ['OPS_MANAGER_NAME', ''],
      ['ALERT_EMAIL', 'info@bethelresidency.com'],
    ]);
    first.appendRow(['AUTO_SEND_EMAILS', 'No']);
    ss.insertSheet('Staff').getRange(1, 1, 2, 2).setValues([['Staff email', 'Name'], ['info@bethelresidency.com', 'Kevin']]);
    ss.insertSheet('Documents').getRange(1, 1, 1, 3).setValues([['Name (what Gemini picks by)', 'Drive link', 'When to use']]);
    const rules = ss.insertSheet('Rules');
    rules.getRange(1, 1, 1, 8).setValues([['Active', 'If field', 'Condition', 'Value', 'And field', 'Condition', 'Value', 'Checklist item']]);
    rules.getRange(2, 1, STARTER_RULES.length, 8).setValues(STARTER_RULES);
    ss.insertSheet('Calls Log').getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    ss.getSheets().forEach(function (s) { s.setFrozenRows(1); });
  }
  ensureMatter_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPipeline') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPipeline').timeBased().everyMinutes(30).create();
  if (!P.getProperty('WINDOW_START')) P.setProperty('WINDOW_START', new Date(Date.now() - 3600 * 1000).toISOString());
  console.log('Setup done. Sheet: ' + sheetUrl_());
}

function checkSetup() {
  const line = function (label, fn) {
    try { fn(); console.log('OK   ' + label); } catch (e) { console.log('FAIL ' + label + ': ' + e.message); }
  };
  line('Script properties', function () { ['GCP_PROJECT_ID', 'GEMINI_MODEL', 'HB_FUNCTION_URL', 'HB_SECRET', 'HB_USER_ID', 'SHEET_ID'].forEach(cfg); });
  line('Sheet + settings', function () { const s = readSettings_(); if (!s.OPS_MANAGER_EMAIL) throw new Error('OPS_MANAGER_EMAIL is empty'); });
  line('Rules parse', function () { const r = readRules_(); r.forEach(function (x) { x.conds.forEach(function (c) { ruleField_(c[0]); test_({}, ruleField_(c[0]), c[1], c[2]); }); }); });
  line('Documents open', function () { readDocuments_().forEach(function (d) { DriveApp.getFileById(d.id).getName(); }); });
  line('Vault matter', function () { vault_('get', '/matters/' + ensureMatter_()); });
  line('Gemini (Vertex)', function () { gemini_('Reply with JSON {"ok":true}.', 'ping', { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } }); });
  line('HouseBoss open + Drive pass', function () { const hb = hbCall_('open', {}); new HbDrive_(hb.access_token).folder(); });
  line('Intake fields loaded', function () { if (!INTAKE_FIELDS.length) throw new Error('IntakeFields.gs is empty'); });
}

/** STARTER rules, drafted by Claude from the intake form for Kev to review, edit or delete.
 *  Option values match lib/intake-form.js exactly. {field} inserts that answer. */
const STARTER_RULES = [
  ['Yes', 'mhDx', 'includes any of', 'Depression, Bipolar, Schizophrenia, PTSD, Anxiety, ADHD, TBI, Other MH', 'mhTreatment', 'is one of', 'No, Needs Referral', 'Connect to a local behavioral health provider (e.g., Jefferson Wellness) in the first week.'],
  ['Yes', 'medCompliant', 'is', 'No', '', '', '', 'Set up medication support: confirm med list and pharmacy; daily med check-ins with the house manager.'],
  ['Yes', 'onMedication', 'is one of', 'Yes – Psychiatric, Yes – Medical, Yes – Both', '', '', '', 'Collect current medication list and pharmacy at move-in; set up secure med storage.'],
  ['Yes', 'adlIndependent', 'is one of', 'No – Needs Some Help, No – Needs Significant Help', '', '', '', 'Confirm ADL support needs before move-in; consider an IHSS referral.'],
  ['Yes', 'substanceUse', 'includes any of', 'Alcohol, Marijuana, Meth, Opioids, Crack/Cocaine', 'substanceTreatment', 'is', 'No – Not in Treatment', 'Offer a substance-use treatment referral (outpatient / MAT).'],
  ['Yes', 'mediCalStatus', 'is one of', 'Pending, Lapsed / Needs Renewal, Never Had, Needs Assistance Applying', '', '', '', 'Help apply for or renew Medi-Cal.'],
  ['Yes', 'benefits', 'includes any of', 'Medi-Cal', 'mediCalId', 'is blank', '', 'Collect Medi-Cal BIC / ID number at move-in.'],
  ['Yes', 'ssiStatus', 'is one of', 'Never Applied, Needs Assistance Applying, Denied – Appealing', '', '', '', 'Start SSI/SSDI application or appeal assistance.'],
  ['Yes', 'income', 'includes any of', 'None', '', '', '', 'Build an income plan before first rent is due (General Relief, CalFresh, employment).'],
  ['Yes', 'repPayee', 'is', 'Needs One', '', '', '', 'Refer for a representative payee.'],
  ['Yes', 'probationParole', 'is one of', 'Yes – Probation, Yes – Parole, Yes – Both', '', '', '', 'Get PO name and phone; confirm the PO has approved the address.'],
  ['Yes', 'dischargingFrom', 'is not blank', '', '', '', '', 'Request discharge paperwork and medication list from {dischargingFrom}.'],
  ['Yes', 'recentHospital', 'is one of', 'Yes – Psychiatric, Yes – Medical, Yes – Both', '', '', '', 'Ask about follow-up appointments from the recent hospital stay; add them to the calendar.'],
];
