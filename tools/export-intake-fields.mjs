// tools/export-intake-fields.mjs
// Generates apps-script/call-automation/IntakeFields.gs from lib/intake-form.js so
// the phone automation fills exactly the fields the Intake tab shows.
// Usage: node tools/export-intake-fields.mjs
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const src = fs.readFileSync(new URL("lib/intake-form.js", root), "utf8");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { SECTIONS } = ctx.window.intakeForm;

const sections = SECTIONS.map((s) => ({
  title: s.title,
  fields: s.fields
    .filter((f) => f.name)
    .map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.dynamic ? { dynamic: f.dynamic } : {}),
      ...(f.options
        ? { options: f.options.map((o) => (typeof o === "string" ? o : o.value)) }
        : {}),
    })),
}));

const out =
  "// IntakeFields.gs: GENERATED from bethel-dashboard/lib/intake-form.js by\n" +
  "// tools/export-intake-fields.mjs. Do not edit by hand.\n" +
  `const INTAKE_SECTIONS = ${JSON.stringify(sections, null, 2)};\n` +
  "const INTAKE_FIELDS = INTAKE_SECTIONS.reduce((all, s) => all.concat(s.fields), []);\n";

const dir = new URL("apps-script/call-automation/", root);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(new URL("IntakeFields.gs", dir), out);
console.log(
  `Wrote ${sections.reduce((n, s) => n + s.fields.length, 0)} fields to apps-script/call-automation/IntakeFields.gs`
);
