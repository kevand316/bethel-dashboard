/** Transcript.gs: unzip a Vault Voice export and turn each call-log message into a call. */
function readExportCalls_(exp) {
  const files = (exp.cloudStorageSink && exp.cloudStorageSink.files) || [];
  const calls = [];
  files.forEach(function (f) {
    const blob = gcsDownload_(f);
    const parts = /\.zip$/i.test(f.objectName) ? Utilities.unzip(blob.setContentType('application/zip')) : [blob];
    parts.forEach(function (p) {
      const name = p.getName() || f.objectName;
      if (!/\.mbox$/i.test(name)) return;
      const owner = ownerFromName_(name);
      splitMbox_(p.getDataAsString('UTF-8')).forEach(function (raw) {
        const call = callFromMessage_(raw, owner);
        if (call) calls.push(call);
      });
    });
  });
  calls.sort(function (a, b) { return a.when - b.when; });
  return calls;
}

function ownerFromName_(name) {
  const m = String(name).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

function splitMbox_(text) {
  return text.split(/\r?\n(?=From [^\r\n]*\r?\n)/)
    .map(function (m) { return m.replace(/^From [^\r\n]*\r?\n/, ''); })
    .filter(function (m) { return m.trim(); });
}

function parseMime_(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const cut = m ? m.index : raw.length;
  const head = raw.slice(0, cut);
  const body = m ? raw.slice(cut + m[0].length) : '';
  const headers = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(function (line) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return { headers: headers, body: body };
}

function textParts_(raw, out) {
  const msg = parseMime_(raw);
  const ct = msg.headers['content-type'] || 'text/plain';
  const boundary = (ct.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (/^multipart\//i.test(ct) && boundary) {
    msg.body.split('--' + boundary).slice(1).forEach(function (part) {
      if (/^--/.test(part)) return;                       // closing boundary
      textParts_(part.replace(/^\r?\n/, ''), out);
    });
    return out;
  }
  if (!/^text\//i.test(ct)) return out;
  const charset = (ct.match(/charset="?([^";]+)"?/i) || [])[1] || 'UTF-8';
  const enc = (msg.headers['content-transfer-encoding'] || '').toLowerCase();
  let text = msg.body;
  if (enc === 'base64') text = Utilities.newBlob(Utilities.base64Decode(msg.body.replace(/\s+/g, ''))).getDataAsString(charset);
  else if (enc === 'quoted-printable') text = Utilities.newBlob(decodeQP_(msg.body)).getDataAsString(charset);
  out.push({ html: /^text\/html/i.test(ct), text: text });
  return out;
}

function decodeQP_(s) {
  s = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.substr(i + 1, 2);
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      const v = parseInt(hex, 16);
      bytes.push(v > 127 ? v - 256 : v);
      i += 2;
    } else {
      Utilities.newBlob(s[i]).getBytes().forEach(function (b) { bytes.push(b); });
    }
  }
  return bytes;
}

function htmlToText_(h) {
  return h.replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n');
}

function callFromMessage_(raw, owner) {
  const headers = parseMime_(raw).headers;
  const parts = textParts_(raw, []);
  let text = parts.filter(function (p) { return !p.html; }).map(function (p) { return p.text; }).join('\n\n');
  if (!text.trim()) text = parts.filter(function (p) { return p.html; }).map(function (p) { return htmlToText_(p.text); }).join('\n\n');
  text = text.trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) return null;   // call log with no notes
  const phones = ((headers['from'] || '') + ' ' + (headers['to'] || '')).match(/\+?1?\d{10}/g) || [];
  return {
    id: sha_(headers['message-id'] || raw),            // stable, safe for Drive queries
    when: headers['date'] ? new Date(headers['date']) : new Date(),
    owner: owner,
    counterpart: phones[0] || '',
    text: text,
  };
}

/** True when the quote really appears in the transcript (ignoring case, punctuation, spacing). */
function inTranscript_(quote, text) {
  const clean = function (s) { return norm_(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); };
  const q = clean(quote);
  return q.length >= 3 && clean(text).indexOf(q) >= 0;
}
