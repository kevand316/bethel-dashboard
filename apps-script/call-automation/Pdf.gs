/** Pdf.gs: the printable intake: header, checklist, still-needed, every section.
 *  SSN is masked on paper; the full number stays in Drive/HouseBoss. */
function buildPdf_(record, info, base) {
  const e = escHtml_;
  const name = [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unnamed intake';
  const list = function (xs, cls) {
    return xs.length ? '<ul class="' + cls + '">' + xs.map(function (x) { return '<li>' + e(x) + '</li>'; }).join('') + '</ul>' : '<p class="none">None.</p>';
  };
  let h = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#111;margin:28px}' +
    'h1{font-size:18pt;margin:0}.sub{color:#555;margin:3px 0 14px}' +
    'h2{font-size:12pt;border-bottom:2px solid #c9a84c;padding-bottom:3px;margin:18px 0 6px}' +
    'table{width:100%;border-collapse:collapse}td{padding:4px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top}' +
    'td.l{width:36%;color:#444}.q{color:#777;font-size:8.5pt;font-style:italic;margin-top:2px}' +
    '.miss{color:#b00020;font-weight:bold}.dash{color:#aaa}.box{border:1px solid #c9a84c;background:#fbf7ea;padding:6px 12px;margin-top:6px}' +
    'ul{margin:4px 0 4px 18px;padding:0}li{margin:3px 0}ul.red li{color:#b00020}.none{color:#777;margin:4px 0}' +
    '.foot{color:#777;font-size:8.5pt;margin-top:22px}</style></head><body>';
  h += '<h1>' + e(info.org) + ' · Resident Intake</h1>';
  h += '<div class="sub"><b>' + e(name) + '</b>' +
    (record.moveInDate ? ' · Move-in ' + e(fmtDate_(record.moveInDate)) : '') +
    (record.prefLocation ? ' · ' + e(record.prefLocation) : '') +
    ' · Call ' + e(fmtTime_(info.call.when)) + ' with ' + e(info.staff) + '</div>';
  h += '<div class="box"><h2 style="margin-top:4px">Checklist</h2>' + list(info.checklist, '') +
    '<h2>Still needed</h2>' + list(info.stillNeed, 'red') + '</div>';

  INTAKE_SECTIONS.forEach(function (s) {
    h += '<h2>' + e(s.title) + '</h2><table>';
    s.fields.forEach(function (f) {
      let v = record[f.name];
      if (f.name === 'ssn' && v) v = '***-**-' + String(v).slice(-4);
      let cell;
      if (isBlank_(v)) cell = f.required ? '<span class="miss">NOT CAPTURED</span>' : '<span class="dash">—</span>';
      else cell = e(show_(v)).replace(/\n/g, '<br>');
      const q = info.sources[f.name];
      if (q && f.name !== 'ssn') cell += '<div class="q">“' + e(q) + '”</div>';
      h += '<tr><td class="l">' + e(f.label) + '</td><td>' + cell + '</td></tr>';
    });
    h += '</table>';
  });
  h += '<div class="foot">Filled automatically from a recorded phone call. Italic lines are the words said on the call. ' +
    'NOT CAPTURED means it was not said and must be collected. Edit this intake in HouseBoss → Intake.</div></body></html>';
  return Utilities.newBlob(h, 'text/html', base + '.html').getAs('application/pdf').setName(base + '.pdf');
}
