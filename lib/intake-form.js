// lib/intake-form.js
// The intake form itself: field definitions, renderer, and read/write helpers.
//
// Ported from intake.bethelresidency.com, which is a hand-written 1,300-line
// HTML file. It is defined as data here instead of markup for three reasons:
//   - The same definition drives rendering, saving to Drive, and the printed
//     PDF. Three hand-maintained copies of sixty fields would drift apart.
//   - Adding a field is one line, not four edits in three places.
//   - Tests can walk the definition instead of hard-coding selectors.
//
// Every field is keyed by `name`, and a saved record is a flat object of
// name -> value. Checkbox groups hold arrays. That shape is the file format in
// Drive, so renaming a `name` breaks previously saved intakes — add a new field
// rather than renaming an old one.
//
// Exposes window.intakeForm.

(function () {
  const YESNO = ["Yes", "No"];
  const RELATIONSHIP = [
    "Parent",
    "Sibling",
    "Spouse / Partner",
    "Child",
    "Friend",
    "Case Manager",
    "Other",
  ];

  // ── field definitions ──────────────────────────────────────────────────────
  const SECTIONS = [
    {
      key: "personal",
      icon: "👤",
      title: "Personal Information",
      fields: [
        {
          name: "firstName",
          label: "First Name",
          type: "text",
          required: true,
          placeholder: "First name",
        },
        {
          name: "lastName",
          label: "Last Name",
          type: "text",
          required: true,
          placeholder: "Last name",
        },
        { name: "dob", label: "Date of Birth", type: "date", required: true },
        {
          name: "gender",
          label: "Gender",
          type: "select",
          options: ["Male", "Female", "Non-binary", "Prefer not to say", "Other"],
        },
        {
          name: "phone",
          label: "Phone Number",
          type: "tel",
          required: true,
          placeholder: "(909) 000-0000",
        },
        { name: "phoneAlt", label: "Alternate Phone", type: "tel", placeholder: "(909) 000-0000" },
        {
          name: "email",
          label: "Email Address",
          type: "email",
          wide: true,
          placeholder: "client@email.com",
        },
        {
          name: "ssn",
          label: "Social Security Number",
          type: "text",
          required: true,
          placeholder: "XXX-XX-XXXX",
          maxlength: 11,
          format: "ssn",
          hint: "Format: 000-00-0000 — handle with confidentiality",
        },
        {
          name: "ethnicity",
          label: "Ethnicity",
          type: "select",
          options: [
            "Hispanic / Latino",
            "Black / African American",
            "White / Caucasian",
            "Asian / Pacific Islander",
            "Native American",
            "Two or More Races",
            "Other",
            "Prefer not to say",
          ],
        },
        {
          name: "language",
          label: "Primary Language",
          type: "select",
          options: ["English", "Spanish", "Other"],
        },
      ],
    },
    {
      key: "housing",
      icon: "🏠",
      title: "Housing History & Current Situation",
      fields: [
        {
          name: "currentSituation",
          label: "Current Living Situation",
          type: "radio",
          required: true,
          wide: true,
          options: [
            { value: "Homeless", label: "Homeless / Unsheltered" },
            { value: "Shelter", label: "Emergency Shelter" },
            { value: "Transitional", label: "Transitional Housing" },
            { value: "Hospital", label: "Hospital / Facility" },
            { value: "Staying with others", label: "Staying with Others" },
            { value: "Other", label: "Other" },
          ],
        },
        {
          name: "homelessDuration",
          label: "How long without stable housing?",
          type: "select",
          options: [
            "Less than 1 month",
            "1–3 months",
            "3–6 months",
            "6–12 months",
            "1–2 years",
            "2+ years",
            "Chronically homeless",
          ],
        },
        {
          name: "lastAddress",
          label: "Last Permanent Address (City)",
          type: "text",
          placeholder: "City, CA",
        },
        {
          name: "housingLossReason",
          label: "Reason for Losing Housing",
          type: "select",
          options: [
            "Eviction",
            "Financial",
            "Domestic Violence",
            "Substance Use",
            "Mental Health",
            "Incarceration",
            "Hospitalization",
            "Other",
          ],
        },
        { name: "moveInDate", label: "Desired Move-In Date", type: "date" },
        // Options come from the operator's own properties at render time — see
        // renderForm(). The original form hard-coded Bethel's five addresses,
        // which would be meaningless to any other operator using the dashboard.
        {
          name: "prefLocation",
          label: "Preferred Home",
          type: "select",
          dynamic: "homes",
          blankLabel: "No preference / Any available",
        },
        {
          name: "evictionHistory",
          label: "Previous Evictions or Landlord Issues?",
          type: "textarea",
          wide: true,
          placeholder: "Describe any prior evictions, unlawful detainers, or landlord disputes...",
        },
      ],
    },
    {
      key: "income",
      icon: "💰",
      title: "Income & Benefits",
      fields: [
        {
          name: "income",
          label: "Income Sources (select all that apply)",
          type: "check",
          wide: true,
          options: [
            "SSI",
            "SSDI",
            "CalWORKs",
            "General Relief",
            "Employment",
            "Veterans Benefits",
            "Pension",
            "None",
          ],
        },
        {
          name: "monthlyIncome",
          label: "Total Monthly Income",
          type: "text",
          placeholder: "$0.00",
        },
        {
          name: "ssiStatus",
          label: "SSI/SSDI Application Status",
          type: "select",
          options: [
            "Currently Receiving",
            "Pending / Applied",
            "Denied – Appealing",
            "Never Applied",
            "Needs Assistance Applying",
          ],
        },
        { type: "divider" },
        {
          name: "benefits",
          label: "Current Benefits (select all that apply)",
          type: "check",
          wide: true,
          options: ["Medi-Cal", "Medicare", "CalFresh", "VA Benefits", "IHSS", "None"],
        },
        {
          name: "mediCalStatus",
          label: "Medi-Cal Status",
          type: "select",
          options: [
            "Active",
            "Pending",
            "Lapsed / Needs Renewal",
            "Never Had",
            "Needs Assistance Applying",
          ],
        },
        {
          name: "mediCalId",
          label: "Medi-Cal ID Number",
          type: "text",
          placeholder: "Medi-Cal BIC / ID number",
        },
        {
          name: "repPayee",
          label: "Has Rep Payee?",
          type: "select",
          options: ["Yes", "No", "Needs One"],
        },
      ],
    },
    {
      key: "medical",
      icon: "🏥",
      title: "Medical & Mental Health History",
      fields: [
        {
          name: "mhDx",
          label: "Mental Health Diagnoses (select all that apply)",
          type: "check",
          wide: true,
          options: [
            "Depression",
            "Bipolar",
            "Schizophrenia",
            "PTSD",
            "Anxiety",
            "ADHD",
            "TBI",
            "Other MH",
            "None",
          ],
        },
        {
          name: "substanceUse",
          label: "Substance Use History (select all that apply)",
          type: "check",
          wide: true,
          options: [
            "Alcohol",
            "Marijuana",
            "Meth",
            "Opioids",
            "Crack/Cocaine",
            "In Recovery",
            "None",
          ],
        },
        { name: "lastUseDate", label: "Date of Last Use", type: "date" },
        {
          name: "substanceTreatment",
          label: "Currently in Treatment / Sober Living?",
          type: "select",
          options: [
            "Yes – Outpatient Program",
            "Yes – AA / NA",
            "Yes – MAT (Medication Assisted)",
            "Completed Treatment",
            "No – Not in Treatment",
            "N/A",
          ],
        },
        {
          name: "onMedication",
          label: "Currently on Medication?",
          type: "select",
          options: ["Yes – Psychiatric", "Yes – Medical", "Yes – Both", "No"],
        },
        {
          name: "mhTreatment",
          label: "Currently in Mental Health Treatment?",
          type: "select",
          options: [
            "Yes – Outpatient",
            "Yes – Case Management",
            "Recently Discharged",
            "No",
            "Needs Referral",
          ],
        },
        {
          name: "physicalHealth",
          label: "Physical Health / Disabilities",
          type: "textarea",
          wide: true,
          placeholder:
            "Note any physical disabilities, chronic conditions, mobility limitations, or special care needs...",
        },
        {
          name: "recentHospital",
          label: "Recent Hospitalization?",
          type: "select",
          options: ["Yes – Psychiatric", "Yes – Medical", "Yes – Both", "No"],
        },
        {
          name: "dischargingFrom",
          label: "Discharging From",
          type: "text",
          placeholder: "Hospital / facility name if applicable",
        },
      ],
    },
    {
      key: "criminal",
      icon: "⚖️",
      title: "Criminal Background",
      fields: [
        {
          name: "hasCriminalHistory",
          label: "Any Criminal History?",
          type: "radio",
          required: true,
          wide: true,
          options: [
            { value: "No", label: "No" },
            { value: "Yes - Misdemeanor", label: "Yes – Misdemeanor" },
            { value: "Yes - Felony", label: "Yes – Felony" },
            { value: "Yes - Both", label: "Yes – Both" },
          ],
        },
        {
          name: "probationParole",
          label: "Currently on Probation or Parole?",
          type: "select",
          options: ["No", "Yes – Probation", "Yes – Parole", "Yes – Both"],
        },
        {
          name: "poName",
          label: "Probation / Parole Officer Name",
          type: "text",
          placeholder: "Officer name if applicable",
        },
        { name: "poPhone", label: "PO Phone Number", type: "tel", placeholder: "(909) 000-0000" },
        {
          name: "sexOffender",
          label: "Registered Sex Offender?",
          type: "radio",
          required: true,
          options: YESNO,
        },
        { name: "arsonHistory", label: "Any Arson History?", type: "radio", options: YESNO },
        {
          name: "criminalNotes",
          label: "Notes on Criminal History",
          type: "textarea",
          wide: true,
          placeholder:
            "Briefly describe nature of charges, dates, outcomes if relevant to placement...",
        },
      ],
    },
    {
      key: "emergency",
      icon: "🆘",
      title: "Emergency Contacts & References",
      fields: [
        {
          name: "ec1Name",
          label: "Emergency Contact Name",
          type: "text",
          required: true,
          placeholder: "Full name",
        },
        { name: "ec1Relationship", label: "Relationship", type: "select", options: RELATIONSHIP },
        {
          name: "ec1Phone",
          label: "EC Phone Number",
          type: "tel",
          required: true,
          placeholder: "(909) 000-0000",
        },
        { name: "ec1Email", label: "EC Email", type: "email", placeholder: "email@example.com" },
        { type: "divider" },
        { name: "ec2Name", label: "2nd Contact Name", type: "text", placeholder: "Full name" },
        {
          name: "ec2Relationship",
          label: "2nd Contact Relationship",
          type: "select",
          options: RELATIONSHIP,
        },
        {
          name: "ec2Phone",
          label: "2nd Contact Phone",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "ec2Email",
          label: "2nd Contact Email",
          type: "email",
          placeholder: "email@example.com",
        },
      ],
    },
    {
      key: "referral",
      icon: "📋",
      title: "Referral Source",
      fields: [
        {
          name: "referralType",
          label: "Referral Type",
          type: "select",
          required: true,
          options: [
            "Hospital / ER",
            "Mental Health Clinic",
            "Nonprofit / CBO",
            "Social Worker",
            "Case Manager",
            "Housing Navigator",
            "Probation / Parole",
            "Self-Referral",
            "211",
            "Other",
          ],
        },
        {
          name: "referralOrg",
          label: "Referring Organization",
          type: "text",
          placeholder: "Organization name",
        },
        {
          name: "referralName",
          label: "Referring Contact Name",
          type: "text",
          placeholder: "Case manager / social worker name",
        },
        {
          name: "referralTitle",
          label: "Title",
          type: "text",
          placeholder: "e.g. Housing Navigator, MSW",
        },
        {
          name: "referralPhone",
          label: "Referral Phone",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "referralEmail",
          label: "Referral Email",
          type: "email",
          placeholder: "referral@org.com",
        },
        {
          name: "referralNotes",
          label: "Referral Notes",
          type: "textarea",
          wide: true,
          placeholder:
            "Any context provided by the referring party, urgency level, special circumstances...",
        },
      ],
    },
    {
      key: "staff",
      icon: "📝",
      title: "Staff Notes",
      fields: [
        {
          name: "staffName",
          label: "Staff Member Completing Intake",
          type: "text",
          placeholder: "Your name",
        },
        { name: "callDateTime", label: "Date / Time of Intake", type: "datetime-local" },
        {
          name: "intakeNotes",
          label: "Intake Notes",
          type: "textarea",
          wide: true,
          tall: true,
          placeholder:
            "Any additional observations, client demeanor, follow-up needed, placement urgency, specific room requests, etc...",
        },
        {
          name: "placementDecision",
          label: "Placement Decision",
          type: "radio",
          wide: true,
          options: ["Approved", "Pending Review", "Waitlist", "Denied"],
        },
      ],
    },
  ];

  // Every input field, flattened. Dividers are layout only and excluded.
  const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields).filter((f) => f.name);

  // ── rendering ──────────────────────────────────────────────────────────────
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

  function normalizeOptions(field) {
    return (field.options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  }

  function renderField(field, ctx) {
    if (field.type === "divider") return '<div class="if-divider"></div>';

    const id = "if-" + field.name;
    const wide = field.wide ? " if-wide" : "";
    const req = field.required ? ' <span class="if-req">*</span>' : "";
    const hint = field.hint ? `<span class="if-hint">${esc(field.hint)}</span>` : "";
    let control = "";

    switch (field.type) {
      case "select": {
        // A dynamic select pulls its options from the operator's own data rather
        // than a hard-coded list.
        const opts =
          field.dynamic === "homes"
            ? (ctx.homes || []).map((h) => ({ value: h, label: h }))
            : normalizeOptions(field);
        control =
          `<select id="${id}" name="${esc(field.name)}" data-intake-field>` +
          `<option value="">${esc(field.blankLabel || "Select...")}</option>` +
          opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("") +
          "</select>";
        break;
      }
      case "textarea":
        control =
          `<textarea id="${id}" name="${esc(field.name)}" data-intake-field` +
          `${field.tall ? ' style="min-height:120px"' : ""}` +
          ` placeholder="${esc(field.placeholder || "")}"></textarea>`;
        break;
      case "radio":
        control =
          '<div class="if-choices">' +
          normalizeOptions(field)
            .map(
              (o, i) =>
                `<label><input type="radio" name="${esc(field.name)}" value="${esc(o.value)}" ` +
                `id="${id}-${i}" data-intake-field> ${esc(o.label)}</label>`
            )
            .join("") +
          "</div>";
        break;
      case "check":
        control =
          '<div class="if-choices">' +
          normalizeOptions(field)
            .map(
              (o, i) =>
                `<label><input type="checkbox" name="${esc(field.name)}" value="${esc(o.value)}" ` +
                `id="${id}-${i}" data-intake-field> ${esc(o.label)}</label>`
            )
            .join("") +
          "</div>";
        break;
      default:
        control =
          `<input type="${esc(field.type)}" id="${id}" name="${esc(field.name)}" data-intake-field` +
          `${field.maxlength ? ` maxlength="${field.maxlength}"` : ""}` +
          `${field.format ? ` data-format="${esc(field.format)}"` : ""}` +
          ` placeholder="${esc(field.placeholder || "")}">`;
    }

    // Radio and checkbox groups get a plain label, not a <label for>, because
    // pointing at one of several inputs would steal clicks from the others.
    const labelTag =
      field.type === "radio" || field.type === "check"
        ? `<span class="if-label">${esc(field.label)}${req}</span>`
        : `<label class="if-label" for="${id}">${esc(field.label)}${req}</label>`;

    return `<div class="if-group${wide}">${labelTag}${control}${hint}</div>`;
  }

  // ctx.homes: the operator's property names, for the Preferred Home dropdown.
  function renderForm(container, ctx = {}) {
    container.innerHTML = SECTIONS.map(
      (section) => `
      <section class="if-section" id="if-section-${section.key}">
        <header class="if-section-head" data-intake-toggle>
          <span class="if-section-icon">${section.icon}</span>
          <h3 class="if-section-title">${esc(section.title)}</h3>
          <span class="if-section-badge" id="if-badge-${section.key}"></span>
          <span class="if-chevron">▾</span>
        </header>
        <div class="if-section-body">
          ${section.fields.map((f) => renderField(f, ctx)).join("")}
        </div>
      </section>
    `
    ).join("");
  }

  // ── read / write ───────────────────────────────────────────────────────────
  // Reads the whole form into the flat record shape that gets written to Drive.
  function readForm(container) {
    const record = {};
    for (const field of ALL_FIELDS) {
      const nodes = container.querySelectorAll(`[name="${CSS.escape(field.name)}"]`);
      if (!nodes.length) continue;

      if (field.type === "check") {
        record[field.name] = Array.from(nodes)
          .filter((n) => n.checked)
          .map((n) => n.value);
      } else if (field.type === "radio") {
        const picked = Array.from(nodes).find((n) => n.checked);
        record[field.name] = picked ? picked.value : "";
      } else {
        record[field.name] = nodes[0].value;
      }
    }
    return record;
  }

  // Fills the form from a saved record. Anything absent is cleared rather than
  // left over from a previously open intake — a stale SSN from the last client
  // showing up in this one would be a serious error, not a cosmetic one.
  function writeForm(container, record = {}) {
    for (const field of ALL_FIELDS) {
      const nodes = container.querySelectorAll(`[name="${CSS.escape(field.name)}"]`);
      if (!nodes.length) continue;
      const value = record[field.name];

      if (field.type === "check") {
        const picked = Array.isArray(value) ? value : [];
        nodes.forEach((n) => {
          n.checked = picked.includes(n.value);
        });
      } else if (field.type === "radio") {
        nodes.forEach((n) => {
          n.checked = n.value === value;
        });
      } else {
        nodes[0].value = value == null ? "" : value;
      }
    }
  }

  // ── completion ─────────────────────────────────────────────────────────────
  function isFilled(record, field) {
    const v = record[field.name];
    return field.type === "check" ? Array.isArray(v) && v.length > 0 : !!(v && String(v).trim());
  }

  // Per-section progress, used for the section badges and the top progress bar.
  // Counts required fields when a section has any, otherwise all of them — a
  // section of optional notes should still be able to read as done.
  function sectionProgress(record) {
    return SECTIONS.map((section) => {
      const fields = section.fields.filter((f) => f.name);
      const required = fields.filter((f) => f.required);
      const counted = required.length ? required : fields;
      const done = counted.filter((f) => isFilled(record, f)).length;
      return { key: section.key, done, total: counted.length, complete: done === counted.length };
    });
  }

  // Overall completion across every required field in the form.
  function requiredProgress(record) {
    const required = ALL_FIELDS.filter((f) => f.required);
    const done = required.filter((f) => isFilled(record, f)).length;
    return {
      done,
      total: required.length,
      pct: required.length ? Math.round((done / required.length) * 100) : 0,
    };
  }

  function missingRequired(record) {
    return ALL_FIELDS.filter((f) => f.required && !isFilled(record, f)).map((f) => f.label);
  }

  // A blank record with every key present, so a new intake and a loaded one have
  // the same shape and JSON diffs in Drive stay readable.
  function blankRecord() {
    const r = {};
    for (const f of ALL_FIELDS) r[f.name] = f.type === "check" ? [] : "";
    return r;
  }

  function displayName(record) {
    const name = [record?.firstName, record?.lastName].filter(Boolean).join(" ").trim();
    return name || "Unnamed intake";
  }

  window.intakeForm = {
    SECTIONS,
    ALL_FIELDS,
    renderForm,
    readForm,
    writeForm,
    sectionProgress,
    requiredProgress,
    missingRequired,
    blankRecord,
    displayName,
  };
})();
