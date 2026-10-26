/** Gemini.gs: one Vertex AI call per transcript. Returns call type, intake fields, actions. */
const CALL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    callType: { type: 'STRING', enum: ['intake', 'referral_partner', 'client_or_family', 'vendor_or_other', 'none'] },
    summary: { type: 'STRING' },
    otherParty: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' }, organization: { type: 'STRING' }, email: { type: 'STRING' }, phone: { type: 'STRING' } },
    },
    intakeFields: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          value: { type: 'STRING' },
          values: { type: 'ARRAY', items: { type: 'STRING' } },
          quote: { type: 'STRING' },
        },
        required: ['name', 'quote'],
      },
    },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['email', 'reminder'] },
          reason: { type: 'STRING' },
          quote: { type: 'STRING' },
          to: { type: 'STRING' },
          subject: { type: 'STRING' },
          body: { type: 'STRING' },
          documents: { type: 'ARRAY', items: { type: 'STRING' } },
          title: { type: 'STRING' },
          when: { type: 'STRING' },
          notes: { type: 'STRING' },
        },
        required: ['kind', 'reason', 'quote'],
      },
    },
  },
  required: ['callType', 'summary', 'actions'],
};

function analyzeCall_(call, ctx) {
  const org = ctx.settings.ORG_NAME;
  const callDate = Utilities.formatDate(call.when, TZ, 'yyyy-MM-dd (EEEE)');
  const fieldList = INTAKE_FIELDS.map(function (f) {
    const choices = f.dynamic === 'homes' ? ctx.homes : (f.options || []);
    return f.name + ' | ' + f.label + ' | ' + f.type + (choices.length ? ' | ' + choices.join(' ; ') : '');
  }).join('\n');
  const docs = ctx.documents.length
    ? ctx.documents.map(function (d) { return '- ' + d.name + (d.use ? ' (use when: ' + d.use + ')' : ''); }).join('\n')
    : '(none)';

  const system = [
    'You process transcripts of phone calls taken by staff of ' + org + ', a supportive housing provider in Riverside County, California. Return JSON only, following the schema.',
    '',
    'HARD RULES',
    '1. Use only what was said in the transcript. Never guess, infer, or fill in typical values. If something was not clearly said, leave it out.',
    '2. Every intake field and every action must include "quote": the exact words from the transcript that support it, copied verbatim (a short phrase or sentence).',
    '3. If the input contains both a summary and a transcript, use the transcript.',
    '',
    'CALL TYPE',
    '"intake" only if staff collected a prospective resident\'s intake information (their name plus intake questions). "none" if there is no real conversation.',
    '',
    'INTAKE FIELDS (only when callType is "intake")',
    'Use the field names below exactly. For choice fields, "value" must be exactly one of the listed choices. For multi-choice (check) fields use "values". Dates as YYYY-MM-DD. The call date is ' + callDate + '; resolve relative dates like "next Thursday" from it. Spell names, emails and ID numbers exactly as spelled out on the call. moveInDate and prefLocation are the move-in date and home staff confirmed on the call.',
    'Fields (name | label | type | choices):',
    fieldList,
    '',
    'ACTIONS',
    'Create an action only when a staff member committed to something on the call (for example "I\'ll email you our information", "I\'ll call you Tuesday") or agreed to something the other person asked for. Do not invent tasks.',
    '- email: the message the staff member promised, warm, professional and concise, from ' + org + '. No signature or sign-off name (added automatically). "to" only if an email address was stated on the call. Attach documents only by exact name from this list, only when they fit:',
    docs,
    '  Never put a client\'s health, diagnosis, criminal, benefits or ID details in an email to someone outside ' + org + '.',
    '- reminder: short "title"; "when" as YYYY-MM-DDTHH:MM Pacific time; if no time was said use 09:00; if no day was said use the next business day after the call.',
  ].join('\n');

  const user = 'Call date/time: ' + fmtTime_(call.when) + '\nStaff on the call: ' + ctx.staffName +
    '\nOther phone number: ' + (call.counterpart || 'unknown') + '\n\nTRANSCRIPT:\n<<<\n' + call.text + '\n>>>';

  return gemini_(system, user, CALL_SCHEMA);
}

function gemini_(systemText, userText, schema) {
  const project = cfg('GCP_PROJECT_ID');
  const loc = cfg('VERTEX_LOCATION', 'us-central1');
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : loc + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + project + '/locations/' + loc +
    '/publishers/google/models/' + cfg('GEMINI_MODEL') + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const data = JSON.parse(res.getContentText());
  const text = (((data.candidates || [])[0] || {}).content || { parts: [{}] }).parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}
