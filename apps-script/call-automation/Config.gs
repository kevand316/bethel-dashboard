/** Config.gs: settings, shared helpers. Secrets live in Script Properties, never in code. */
const TZ = 'America/Los_Angeles';
const P = PropertiesService.getScriptProperties();
const ROOT_FOLDER_NAME = 'HouseBoss Intake Forms';   // same as lib/drive.js
const LEGACY_FOLDER_NAME = 'Bethel Intake Forms';    // pre-rebrand name; dashboard renames it
const MIN_TRANSCRIPT_CHARS = 300;                    // shorter = a plain call log with no notes (confirm at first test)

function cfg(key, fallback) {
  const v = P.getProperty(key);
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing script property ' + key);
  }
  return v;
}

/** Lowercase, unify dashes, collapse spaces: so "Yes - Felony" matches "Yes – Felony". */
function norm_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[‒-―]/g, '-').replace(/\s+/g, ' ').trim();
}

function isBlank_(v) {
  return v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
}

function show_(v) {
  return Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
}

function fmtTime_(d) {
  return Utilities.formatDate(d, TZ, 'EEE M/d h:mm a');
}

function fmtDate_(ymd) {
  if (!ymd) return '';
  return Utilities.formatDate(Utilities.parseDate(ymd, TZ, 'yyyy-MM-dd'), TZ, 'EEE M/d');
}

function sha_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 32);
}

/** Per-call step markers, so a retried run never repeats a finished step. */
function stepDone_(key) { return P.getProperty('STEP:' + key) === '1'; }
function markStep_(key) { P.setProperty('STEP:' + key, '1'); }
function clearSteps_(callId) {
  const all = P.getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf('STEP:' + callId) === 0) P.deleteProperty(k); });
}

/** Tell Kev something needs a look: email + HouseBoss text. No client details in either.
 *  The same message goes out at most once every 6 hours. */
function alert_(msg) {
  const key = 'ALERT:' + sha_(msg);
  if (Date.now() - Number(P.getProperty(key) || 0) < 6 * 3600 * 1000) return;
  P.setProperty(key, String(Date.now()));
  try {
    GmailApp.sendEmail(setting_('ALERT_EMAIL'), 'HouseBoss call automation needs attention',
      msg + '\n\nCalls Log: ' + sheetUrl_());
  } catch (e) { console.error('alert email failed', e); }
  try { hbCall_('alert', {}); } catch (e) { console.error('alert text failed', e); }
}
