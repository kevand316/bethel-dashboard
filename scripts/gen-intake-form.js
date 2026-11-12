#!/usr/bin/env node
// Rebuilds the SECTIONS block of lib/intake-form.js from the printed Client
// Intake Assessment (bethel-client-intake skill, assets/intake_fields.json), so
// the online form and the printed form are always the same form.
//
//   node scripts/gen-intake-form.js [path/to/intake_fields.json]
//
// Then: npx prettier --write lib/intake-form.js && npx playwright test
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC =
  process.argv[2] ||
  path.join(os.homedir(), ".claude/skills/bethel-client-intake/assets/intake_fields.json");
const TARGET = path.join(__dirname, "..", "lib", "intake-form.js");

const schema = JSON.parse(fs.readFileSync(SRC, "utf8"));
const js = fs.readFileSync(TARGET, "utf8");

// Input settings the printed form does not carry (date pickers, SSN format,
// which boxes are required). Keyed by field name.
const INPUT = {
  callDateTime: { type: "datetime-local" },
  firstName: { required: true },
  lastName: { required: true },
  phone: { type: "tel", required: true, placeholder: "(909) 000-0000" },
  phoneAlt: { type: "tel", placeholder: "(909) 000-0000" },
  email: { type: "email" },
  dob: { type: "date", required: true },
  ssn: {
    required: true,
    placeholder: "XXX-XX-XXXX",
    maxlength: 11,
    format: "ssn",
    hint: "Format: 000-00-0000 — handle with confidentiality",
  },
  hasCriminalHistory: { required: true },
  sexOffender: { required: true },
  currentSituation: { required: true },
  ec1Name: { required: true },
  ec1Phone: { type: "tel", required: true, placeholder: "(909) 000-0000" },
  ec2Phone: { type: "tel", placeholder: "(909) 000-0000" },
  referralType: { required: true },
  referralPhone: { type: "tel" },
  moveInDate: { type: "date" },
  prefLocation: {
    type: "select",
    dynamic: "homes",
    blankLabel: "No preference / Any available",
  },
  criminalNotes: { type: "textarea", wide: true },
  physicalHealth: { type: "textarea", wide: true },
  intakeNotes: { type: "textarea", wide: true, tall: true },
};
// Single-answer questions shown as a dropdown instead of radio buttons.
const DROPDOWN = new Set([
  "adlIndependent",
  "lastUse",
  "medCompliant",
  "mediCalPlan",
  "probationParole",
  "language",
  "gender",
  "ethnicity",
  "repPayee",
  "mediCalStatus",
  "recentHospital",
  "mhTreatment",
  "substanceTreatment",
  "mobilityAid",
  "homelessDuration",
  "referralType",
]);
const ICONS = [
  [/program/i, "🏠"],
  [/income|benefit/i, "💵"],
  [/daily living/i, "🧍"],
  [/substance/i, "🌱"],
  [/behavioral/i, "🧠"],
  [/background/i, "⚖️"],
  [/result/i, "✅"],
  [/personal/i, "👤"],
  [/insurance/i, "💳"],
  [/medical/i, "🩺"],
  [/living history/i, "🛏️"],
  [/emergency/i, "📞"],
  [/goal/i, "🎯"],
  [/document/i, "📄"],
  [/recuperative/i, "❤️‍🩹"],
  [/move-in/i, "📦"],
  [/after the call/i, "🤝"],
  [/needs/i, "🧾"],
];
const FALLBACK_LABEL = { screenResult: "Result", clientNeeds: "Needs", noShow: "No-show" };

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function field(it) {
  const extra = INPUT[it.name] || {};
  const label = it.label || FALLBACK_LABEL[it.name] || it.name;
  const out = [];
  if (it.k === "choice") {
    const type =
      it.multi || it.options.length === 1 ? "check" : DROPDOWN.has(it.name) ? "select" : "radio";
    out.push({
      name: it.name,
      label,
      type,
      ...(type !== "select" && (it.options.length > 3 || label.length > 45) ? { wide: true } : {}),
      options: it.options,
      ...extra,
    });
    if (it.other) out.push({ name: it.name + "Other", label: label + " (other)", type: "text" });
  } else {
    out.push({
      name: it.name,
      label,
      type: "text",
      ...(label.length > 45 ? { wide: true } : {}),
      ...extra,
    });
  }
  return out;
}

function fieldsOf(section) {
  const out = [];
  for (const row of section.rows || []) {
    for (const it of row) {
      if (it.k === "say" || it.k === "refer") out.push({ type: "note", label: it.text });
      else if (it.k === "callout") {
        out.push({ type: "note", label: `${it.lead} ${it.text}` });
        for (const sub of it.row || []) out.push(...field(sub));
      } else if (it.k === "table") {
        it.cells.forEach((cells, r) => {
          out.push({ type: "heading", label: `${it.cols[0]} ${r + 1}` });
          cells.forEach((name, c) => out.push(...field({ k: "text", name, label: it.cols[c] })));
        });
      } else if (it.name) out.push(...field(it));
    }
  }
  return out;
}

const sections = [];
const seen = new Set();
for (const page of schema.pages) {
  for (const s of page.sections) {
    const fields = fieldsOf(s);
    if (!fields.some((f) => f.name)) continue;
    const title = s.title
      ? s.num && /^(G?\d+)$/.test(s.num)
        ? `${s.num} · ${s.title}`
        : s.title
      : "Start";
    let key = slug(s.title || "start");
    while (seen.has(key)) key += "-2";
    seen.add(key);
    const icon = (ICONS.find(([re]) => re.test(s.title || "")) || [null, "📝"])[1];
    sections.push({ key, icon, title, fields });
  }
}

const names = sections.flatMap((s) => s.fields.map((f) => f.name).filter(Boolean));
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) throw new Error("Duplicate field names: " + dupes.join(", "));

const start = js.indexOf("  const SECTIONS = [");
const end = js.indexOf("\n  ];", start);
if (start < 0 || end < 0) throw new Error("SECTIONS block not found in lib/intake-form.js");
const block =
  `  // Form version ${schema.version}. GENERATED by scripts/gen-intake-form.js — do not edit by hand.\n` +
  "  const SECTIONS = " +
  JSON.stringify(sections, null, 2);
fs.writeFileSync(TARGET, js.slice(0, start) + block + js.slice(end + "\n  ]".length));
console.log(`intake form ${schema.version}: ${sections.length} sections, ${names.length} boxes`);
