/** Rules.gs: checklist from the Rules tab. Deterministic: same answers, same checklist. */
const RULE_OPS = ['is', 'is not', 'is one of', 'includes any of', 'contains', 'is blank', 'is not blank'];

function readRules_() {
  return sheet_('Rules').getDataRange().getValues().slice(1)
    .filter(function (r) { return /^yes$/i.test(String(r[0]).trim()) && String(r[7]).trim(); })
    .map(function (r) {
      return {
        conds: [[r[1], r[2], r[3]], [r[4], r[5], r[6]]].filter(function (c) { return String(c[0]).trim(); }),
        item: String(r[7]).trim(),
      };
    });
}

/** The Rules tab may name a field by its name (mhDx) or its label (Mental Health Diagnoses...). */
function ruleField_(ref) {
  const r = norm_(ref);
  for (let i = 0; i < INTAKE_FIELDS.length; i++) {
    const f = INTAKE_FIELDS[i];
    if (norm_(f.name) === r || norm_(f.label) === r) return f.name;
  }
  throw new Error('Rules tab: unknown field "' + ref + '"');
}

function applyRules_(record, rules) {
  const out = [];
  rules.forEach(function (rule) {
    const hit = rule.conds.every(function (c) { return test_(record, ruleField_(c[0]), c[1], c[2]); });
    if (!hit) return;
    const item = rule.item.replace(/\{(\w+)\}/g, function (_, f) { return show_(record[f]) || f; });
    if (out.indexOf(item) < 0) out.push(item);
  });
  return out;
}

function test_(record, field, op, value) {
  const raw = record[field];
  const vals = (Array.isArray(raw) ? raw : [raw]).map(norm_).filter(Boolean);
  const want = String(value == null ? '' : value).split(',').map(norm_).filter(Boolean);
  switch (norm_(op)) {
    case 'is blank': return vals.length === 0;
    case 'is not blank': return vals.length > 0;
    case 'is': return vals.length === 1 && vals[0] === want[0];
    case 'is not': return !(vals.length === 1 && vals[0] === want[0]);
    case 'is one of':
    case 'includes any of': return vals.some(function (v) { return want.indexOf(v) >= 0; });
    case 'contains': return vals.some(function (v) { return want.some(function (w) { return v.indexOf(w) >= 0; }); });
    default: throw new Error('Rules tab: unknown condition "' + op + '". Use one of: ' + RULE_OPS.join(', '));
  }
}
