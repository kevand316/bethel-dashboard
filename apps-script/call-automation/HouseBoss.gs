/** HouseBoss.gs: talk to the call-intake Edge Function; write to Drive with its short-lived pass. */
function hbCall_(action, payload) {
  const res = UrlFetchApp.fetch(cfg('HB_FUNCTION_URL'), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-call-intake-secret': cfg('HB_SECRET') },
    payload: JSON.stringify(Object.assign({ action: action, user_id: cfg('HB_USER_ID') }, payload || {})),
    muteHttpExceptions: true,
  });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() >= 300) {
    const why = body.error === 'not_connected'
      ? 'HouseBoss is not allowed to save to Drive. Turn on "Allow texted intakes" in the Intake tab (as info@).'
      : (body.error || res.getContentText().slice(0, 200));
    throw new Error('HouseBoss ' + action + ' -> ' + res.getResponseCode() + ': ' + why);
  }
  return body;
}

/** Drive REST with the HouseBoss drive.file token, so files belong to the HouseBoss app
 *  and the Intake tab can list and open them (same as lib/drive.js). */
function HbDrive_(token) { this.token = token; }

HbDrive_.prototype.api = function (method, path, opt) {
  opt = opt || {};
  const base = opt.upload ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3';
  const qs = opt.query ? '?' + Object.keys(opt.query).map(function (k) { return k + '=' + encodeURIComponent(opt.query[k]); }).join('&') : '';
  const params = { method: method, headers: { Authorization: 'Bearer ' + this.token }, muteHttpExceptions: true };
  if (opt.payload !== undefined) { params.payload = opt.payload; params.contentType = opt.contentType || 'application/json'; }
  const res = UrlFetchApp.fetch(base + path + qs, params);
  if (res.getResponseCode() >= 300) throw new Error('Drive ' + method + ' ' + path + ' -> ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  const t = res.getContentText();
  return t ? JSON.parse(t) : {};
};

HbDrive_.prototype.folder = function () {
  const names = [ROOT_FOLDER_NAME, LEGACY_FOLDER_NAME];
  for (let i = 0; i < names.length; i++) {
    const r = this.api('get', '/files', { query: {
      q: "name='" + names[i] + "' and mimeType='application/vnd.google-apps.folder' and trashed=false", fields: 'files(id)' } });
    if (r.files && r.files.length) return r.files[0].id;
  }
  return this.api('post', '/files', { query: { fields: 'id' },
    payload: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) }).id;
};

/** One JSON file per intake, same shape and metadata as lib/drive.js createIntake().
 *  A retried run finds its own earlier file by callId and never overwrites it
 *  (Kev may already have edited it in the Intake tab). */
HbDrive_.prototype.saveIntake = function (folder, name, record, callId) {
  const found = this.api('get', '/files', { query: {
    q: "'" + folder + "' in parents and trashed=false and appProperties has { key='callId' and value='" + callId + "' }",
    fields: 'files(id)' } });
  if (found.files && found.files.length) return found.files[0].id;
  const created = this.api('post', '/files', { query: { fields: 'id' }, payload: JSON.stringify({
    name: name, parents: [folder], mimeType: 'application/json',
    appProperties: {
      clientName: [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || 'Unnamed intake',
      status: record.placementDecision || '',
      intakeDate: record.intakeDate || '',
      callId: callId,
    } }) });
  this.api('patch', '/files/' + created.id, { upload: true, query: { uploadType: 'media' },
    payload: JSON.stringify(record, null, 2), contentType: 'application/json' });
  return created.id;
};

HbDrive_.prototype.upload = function (folder, blob, mime) {
  const created = this.api('post', '/files', { query: { fields: 'id' },
    payload: JSON.stringify({ name: blob.getName(), parents: [folder], mimeType: mime }) });
  this.api('patch', '/files/' + created.id, { upload: true, query: { uploadType: 'media' }, payload: blob.getBytes(), contentType: mime });
  return created.id;
};
