/** Vault.gs: export Voice call logs (with Gemini notes transcripts) for the whole org. */
const VAULT = 'https://vault.googleapis.com/v1';

function vault_(method, path, body) {
  const res = UrlFetchApp.fetch(VAULT + path, {
    method: method,
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('Vault ' + method + ' ' + path + ' -> ' + code + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : {};
}

function ensureMatter_() {
  const existing = P.getProperty('VAULT_MATTER_ID');
  if (existing) return existing;
  const m = vault_('post', '/matters', {
    name: 'HouseBoss call transcripts',
    description: 'Automated export of Google Voice call notes for intake and follow-up processing (plans/phone-intake.md).',
  });
  P.setProperty('VAULT_MATTER_ID', m.matterId);
  return m.matterId;
}

function startExport_() {
  const matter = ensureMatter_();
  const now = new Date();
  const start = P.getProperty('WINDOW_START') || new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const exp = vault_('post', '/matters/' + matter + '/exports', {
    name: 'calls ' + Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'),
    query: {
      corpus: 'VOICE',
      dataScope: 'ALL_DATA',
      searchMethod: 'ENTIRE_ORG',
      startTime: start,
      endTime: now.toISOString(),
      timeZone: TZ,
      voiceOptions: { coveredData: ['CALL_LOGS'] },
    },
    exportOptions: { voiceOptions: { exportFormat: 'MBOX' }, region: 'ANY' },
  });
  P.setProperty('PENDING_EXPORT_ID', exp.id);
  P.setProperty('PENDING_EXPORT_END', now.toISOString());
}

function getExport_(id) {
  return vault_('get', '/matters/' + ensureMatter_() + '/exports/' + id);
}

function clearExport_(id) {
  try { vault_('delete', '/matters/' + ensureMatter_() + '/exports/' + id); } catch (e) { console.warn('export delete', e); }
  P.deleteProperty('PENDING_EXPORT_ID');
  P.deleteProperty('PENDING_EXPORT_END');
}

/** Export files sit in a Google-managed Cloud Storage bucket; the ediscovery +
 *  devstorage.read_only scopes on our own token are what let us read them. */
function gcsDownload_(f) {
  const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(f.bucketName) +
    '/o/' + encodeURIComponent(f.objectName) + '?alt=media';
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('Export download failed ' + res.getResponseCode() + ' for ' + f.objectName);
  return res.getBlob().setName(f.objectName.split('/').pop());
}
