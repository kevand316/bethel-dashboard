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
  // GENERATED to match the Client Intake Assessment (bethel-client-intake skill,
  // assets/intake_fields.json). Same boxes, same names. Add a field rather than
  // renaming one.
  // GENERATED to match the Client Intake Assessment (bethel-client-intake skill,
  // assets/intake_fields.json). Same boxes, same names. Add a field rather than
  // renaming one.
  const SECTIONS = [
    {
      key: "assessment",
      icon: "✅",
      title: "Part 1 · Assessment (five gates)",
      fields: [
        {
          name: "callDateTime",
          label: "Date",
          type: "datetime-local",
        },
        {
          name: "staffName",
          label: "Completed by",
          type: "text",
          placeholder: "Your name",
        },
        {
          name: "callerName",
          label: "Caller (if not the client)",
          type: "text",
        },
        {
          name: "firstName",
          label: "Client first name",
          type: "text",
          required: true,
          placeholder: "First name",
        },
        {
          name: "lastName",
          label: "Last name",
          type: "text",
          required: true,
          placeholder: "Last name",
        },
        {
          name: "phone",
          label: "Phone",
          type: "tel",
          required: true,
          placeholder: "(909) 000-0000",
        },
        {
          type: "heading",
          label: "G1 · Income",
        },
        {
          name: "gateIncome",
          label: "Has income",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "gateIncomeSource",
          label: "Source",
          type: "text",
        },
        {
          name: "monthlyIncome",
          label: "Monthly $",
          type: "text",
          placeholder: "$0.00",
        },
        {
          name: "gateIncomeAccess",
          label: "Can get to the money now",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "gateIncomeConsistent",
          label: "Comes every month",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "gateRentFirstMonth",
          label: "Can pay first month's rent",
          type: "radio",
          options: ["Yes", "Prorated now, full rent next month", "No"],
        },
        {
          type: "note",
          label: "NO income or cannot pay: transition to DPSS · (877) 410-8827",
        },
        {
          type: "heading",
          label: "G2 · Daily living on their own",
        },
        {
          name: "adlOnOwn",
          label: "Does on their own",
          type: "check",
          options: [
            "Eat",
            "Bathe / shower",
            "Get around",
            "Use the bathroom",
            "Take medications",
            "Make meals",
          ],
          wide: true,
        },
        {
          name: "adlIndependent",
          label: "All daily living on their own",
          type: "select",
          options: ["Yes", "No – Needs Some Help", "No – Needs Significant Help"],
        },
        {
          type: "note",
          label:
            "NO: transition to IHSS · (888) 960-4477, and ask the health plan question below (recuperative care)",
        },
        {
          type: "heading",
          label: "G3 · The program",
        },
        {
          type: "note",
          label:
            "Explain: shared housing, a bed in a shared room, house rules, client manager visits. Rent is $800 to $850 a month per bed without food. Food is $300 a month extra. No deposit, no application fee.",
        },
        {
          name: "programExplained",
          label: "Program explained",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "programAgrees",
          label: "Are you willing to participate in our housing program?",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          type: "heading",
          label: "G4 · Substance use",
        },
        {
          name: "lastUse",
          label: "Last use",
          type: "select",
          options: [
            "Within the last 90 days",
            "3 to 6 months ago",
            "6 to 12 months ago",
            "1 to 2 years ago",
            "Over 2 years ago",
            "Never",
          ],
        },
        {
          type: "note",
          label:
            "Within the last 90 days: transition to Solid Ground Wellness and Recovery · (951) 224-9940",
        },
        {
          type: "heading",
          label: "G5 · Diagnosis and medication",
        },
        {
          name: "gateDiagnosis",
          label: "Has a diagnosis with prescribed medication",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "medCompliant",
          label: "Takes it as prescribed",
          type: "select",
          options: ["Yes", "No", "N/A – No Medications"],
        },
        {
          type: "note",
          label:
            "Diagnosis + NOT taking medication: transition to RUHS Jefferson Wellness · (951) 955-8000 or CARES Line · (800) 499-3008",
        },
        {
          type: "heading",
          label: "Health plan · recuperative care question",
        },
        {
          name: "mediCalPlan",
          label: "Which managed care plan do you have?",
          type: "select",
          options: ["IEHP", "Molina", "Kaiser", "None / not sure", "Other"],
        },
        {
          name: "mediCalPlanOther",
          label: "Which managed care plan do you have? (if other)",
          type: "text",
        },
        {
          name: "recupLast12",
          label: 'Kaiser, Molina or IEHP: "Have you used recuperative care in the last 12 months?',
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          type: "note",
          label:
            "NO = can receive recuperative care. YES = cannot receive recuperative care right now, but we still work with them for housing. Never stops the intake.",
        },
        {
          type: "heading",
          label: "Screen result",
        },
        {
          name: "screenResult",
          label: "Result",
          type: "radio",
          options: ["Passed all five · go on to the full intake", "Transition with resources"],
        },
        {
          name: "screenTransitionTo",
          label: "Transitioned to",
          type: "text",
        },
        {
          type: "note",
          label:
            "If it is not a fit, say: \"We'll transition you to ___\" and give the number. Never say it won't work.",
        },
      ],
    },
    {
      key: "criminal",
      icon: "⚖️",
      title: "Part 1 · Background",
      fields: [
        {
          name: "hasCriminalHistory",
          label: "Criminal history",
          type: "radio",
          required: true,
          wide: true,
          options: [
            {
              value: "No",
              label: "No",
            },
            {
              value: "Yes - Misdemeanor",
              label: "Yes – Misdemeanor",
            },
            {
              value: "Yes - Felony",
              label: "Yes – Felony",
            },
            {
              value: "Yes - Both",
              label: "Yes – Both",
            },
          ],
        },
        {
          name: "probationParole",
          label: "On probation or parole",
          type: "select",
          options: ["No", "Yes – Probation", "Yes – Parole", "Yes – Both"],
        },
        {
          name: "poName",
          label: "Officer name",
          type: "text",
          placeholder: "Officer name if applicable",
        },
        {
          name: "poPhone",
          label: "Officer phone",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "sexOffender",
          label: "Registered sex offender",
          type: "radio",
          required: true,
          options: ["Yes", "No"],
        },
        {
          name: "arsonHistory",
          label: "Arson history",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "criminalNotes",
          label: "Notes",
          type: "textarea",
          wide: true,
          placeholder:
            "Briefly describe nature of charges, dates, outcomes if relevant to placement...",
        },
      ],
    },
    {
      key: "personal",
      icon: "👤",
      title: "Part 2 · Personal Information",
      fields: [
        {
          name: "preferredName",
          label: "Preferred name / pronouns",
          type: "text",
        },
        {
          name: "dob",
          label: "Date of birth",
          type: "date",
          required: true,
        },
        {
          name: "ssn",
          label: "SSN",
          type: "text",
          required: true,
          placeholder: "XXX-XX-XXXX",
          maxlength: 11,
          format: "ssn",
          hint: "Format: 000-00-0000 — handle with confidentiality",
        },
        {
          name: "phoneAlt",
          label: "Other phone",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "email",
          label: "Email (if any)",
          type: "email",
          wide: true,
          placeholder: "client@email.com",
        },
        {
          name: "language",
          label: "Primary language",
          type: "select",
          options: ["English", "Spanish", "Other"],
        },
        {
          name: "languageOther",
          label: "Primary language (if other)",
          type: "text",
        },
        {
          name: "gender",
          label: "Gender",
          type: "select",
          options: ["Male", "Female", "Non-binary", "Prefer not to say", "Other"],
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
            "Prefer not to say",
            "Other",
          ],
        },
      ],
    },
    {
      key: "income",
      icon: "💵",
      title: "Income & Benefits",
      fields: [
        {
          name: "income",
          label: "Income sources",
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
            "Other",
          ],
        },
        {
          name: "incomeOther",
          label: "Income sources (if other)",
          type: "text",
        },
        {
          name: "incomeDay",
          label: "Day income arrives",
          type: "text",
        },
        {
          name: "incomeProof90",
          label: "Proof of income, last 90 days",
          type: "radio",
          options: ["Has it", "Needs it"],
        },
        {
          name: "ssiStatus",
          label: "SSI / SSDI",
          type: "select",
          options: [
            "Currently Receiving",
            "Pending / Applied",
            "Denied – Appealing",
            "Never Applied",
            "Needs Assistance Applying",
          ],
        },
        {
          name: "repPayee",
          label: "Rep payee",
          type: "select",
          options: ["Yes", "No", "Needs One"],
        },
        {
          name: "payeeName",
          label: "Payee name",
          type: "text",
        },
        {
          name: "payeePhone",
          label: "Payee phone",
          type: "tel",
        },
        {
          name: "healthInsurance",
          label: "Health insurance",
          type: "select",
          options: ["Medi-Cal", "Medicare", "Both", "None", "Other"],
        },
        {
          name: "healthInsuranceOther",
          label: "Health insurance (if other)",
          type: "text",
        },
        {
          name: "mediCalStatus",
          label: "Medi-Cal status",
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
          label: "Medi-Cal / BIC ID #",
          type: "text",
          placeholder: "Medi-Cal BIC / ID number",
        },
        {
          name: "medicareId",
          label: "Medicare #",
          type: "text",
        },
        {
          name: "benefits",
          label: "Other benefits",
          type: "check",
          wide: true,
          options: ["Medi-Cal", "Medicare", "CalFresh", "VA Benefits", "IHSS", "None"],
        },
      ],
    },
    {
      key: "medical",
      icon: "🏥",
      title: "Medical, Mental Health & Substance Use",
      fields: [
        {
          type: "heading",
          label: "Medical",
        },
        {
          name: "med1Name",
          label: "Medication 1",
          type: "text",
        },
        {
          name: "med1Dose",
          label: "Dose 1",
          type: "text",
        },
        {
          name: "med1Freq",
          label: "How often 1",
          type: "text",
        },
        {
          name: "med1For",
          label: "For 1",
          type: "text",
        },
        {
          name: "med2Name",
          label: "Medication 2",
          type: "text",
        },
        {
          name: "med2Dose",
          label: "Dose 2",
          type: "text",
        },
        {
          name: "med2Freq",
          label: "How often 2",
          type: "text",
        },
        {
          name: "med2For",
          label: "For 2",
          type: "text",
        },
        {
          name: "med3Name",
          label: "Medication 3",
          type: "text",
        },
        {
          name: "med3Dose",
          label: "Dose 3",
          type: "text",
        },
        {
          name: "med3Freq",
          label: "How often 3",
          type: "text",
        },
        {
          name: "med3For",
          label: "For 3",
          type: "text",
        },
        {
          name: "med4Name",
          label: "Medication 4",
          type: "text",
        },
        {
          name: "med4Dose",
          label: "Dose 4",
          type: "text",
        },
        {
          name: "med4Freq",
          label: "How often 4",
          type: "text",
        },
        {
          name: "med4For",
          label: "For 4",
          type: "text",
        },
        {
          name: "med5Name",
          label: "Medication 5",
          type: "text",
        },
        {
          name: "med5Dose",
          label: "Dose 5",
          type: "text",
        },
        {
          name: "med5Freq",
          label: "How often 5",
          type: "text",
        },
        {
          name: "med5For",
          label: "For 5",
          type: "text",
        },
        {
          name: "pharmacy",
          label: "Pharmacy",
          type: "text",
        },
        {
          name: "primaryDoctor",
          label: "Primary doctor / clinic",
          type: "text",
        },
        {
          name: "recentHospital",
          label: "Recent hospital stay",
          type: "select",
          options: ["Yes – Psychiatric", "Yes – Medical", "Yes – Both", "No"],
        },
        {
          name: "dischargeDate",
          label: "Discharge date",
          type: "text",
        },
        {
          name: "dischargingFrom",
          label: "Discharging from",
          type: "text",
          placeholder: "Hospital / facility name if applicable",
        },
        {
          name: "dischargePapers",
          label: "Discharge papers",
          type: "radio",
          options: ["Has them", "Needs them"],
        },
        {
          name: "allergies",
          label: "Allergies (medicine and food)",
          type: "text",
        },
        {
          name: "physicalHealth",
          label: "Physical health / disabilities",
          type: "textarea",
          wide: true,
          placeholder:
            "Note any physical disabilities, chronic conditions, mobility limitations, or special care needs...",
        },
        {
          name: "medicalEquipment",
          label: "Medical equipment (oxygen, CPAP, wound supplies)",
          type: "text",
          wide: true,
        },
        {
          name: "needsSkilledNursing",
          label: "Needs a nurse or 24-hour medical care right now",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "medicallyStable",
          label: "Doctor says stable to leave the hospital",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          type: "heading",
          label: "Mental health",
        },
        {
          name: "mhDx",
          label: "Mental health diagnosis",
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
            "Other",
          ],
        },
        {
          name: "mhDxOther",
          label: "Mental health diagnosis (if other)",
          type: "text",
        },
        {
          name: "onMedication",
          label: "On medication",
          type: "select",
          options: ["Yes – Psychiatric", "Yes – Medical", "Yes – Both", "No"],
        },
        {
          name: "cognitiveConcerns",
          label: "Concerns noticed",
          type: "check",
          options: [
            "Disorientation",
            "Trouble following instructions",
            "Memory challenges",
            "None",
          ],
          wide: true,
        },
        {
          name: "selfHarmRisk",
          label: "Any thoughts of hurting yourself or anyone else?",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "mhTreatment",
          label: "In mental health outpatient",
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
          name: "mhTreatmentWhere",
          label: "Where",
          type: "text",
        },
        {
          type: "note",
          label:
            "Diagnosis + NOT in outpatient: schedule with RUHS Jefferson Wellness Center · (951) 955-8000 · 2085 Rustin Ave, Entrance #4, Riverside 92507",
        },
        {
          name: "jeffersonAppt",
          label: "Appointment date / time",
          type: "text",
        },
        {
          name: "jeffersonNumberGiven",
          label: "Number given to client",
          type: "check",
          options: ["Number given to client"],
          wide: true,
        },
        {
          type: "heading",
          label: "Substance use",
        },
        {
          name: "substanceUse",
          label: "Substances used",
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
            "Other",
          ],
        },
        {
          name: "substanceUseOther",
          label: "Substances used (if other)",
          type: "text",
        },
        {
          name: "substanceTreatment",
          label: "In treatment",
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
          name: "lastUseDate",
          label: "Date of last use",
          type: "date",
        },
        {
          name: "inRecoveryProgram",
          label: "In recovery now",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          type: "note",
          label:
            "Used in the last 2 years + NOT in treatment: schedule with Solid Ground Wellness and Recovery · (951) 224-9940 · 6860 Brockton Ave, Suite 9, Riverside 92506",
        },
        {
          name: "solidGroundAppt",
          label: "Appointment date / time",
          type: "text",
        },
        {
          name: "solidGroundNumberPosted",
          label: "Number posted",
          type: "check",
          options: ["Number posted"],
          wide: true,
        },
        {
          type: "heading",
          label: "Mobility & daily living",
        },
        {
          name: "mobilityAid",
          label: "Uses a mobility aid",
          type: "select",
          options: ["No", "Wheelchair", "Walker", "Cane", "Other"],
        },
        {
          name: "mobilityAidOther",
          label: "Uses a mobility aid (if other)",
          type: "text",
        },
        {
          name: "fallRisk",
          label: "Falls in the last year",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "wantsHomeHelp",
          label: "Would it benefit you to have someone help with your cooking or cleaning?",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "needsHelpWith",
          label: "Needs help with",
          type: "check",
          options: [
            "Walking",
            "Hygiene",
            "Dressing",
            "Getting meals",
            "Managing medications",
            "Rides",
            "Nothing",
          ],
          wide: true,
        },
        {
          name: "needsHelpExplain",
          label: "Explain",
          type: "text",
        },
        {
          type: "note",
          label:
            "Mobility aid + answered YES: schedule with Riverside County IHSS Home Line · (888) 960-4477 · RiversideIHSS.org",
        },
        {
          name: "ihssAppt",
          label: "Appointment date / time",
          type: "text",
        },
        {
          name: "ihssNumberGiven",
          label: "Number given to client",
          type: "check",
          options: ["Number given to client"],
          wide: true,
        },
      ],
    },
    {
      key: "housing",
      icon: "🏠",
      title: "Housing & Recuperative Care Assessment",
      fields: [
        {
          name: "currentSituation",
          label: "Living situation now",
          type: "radio",
          required: true,
          wide: true,
          options: [
            {
              value: "Homeless",
              label: "Homeless / Unsheltered",
            },
            {
              value: "Shelter",
              label: "Emergency Shelter",
            },
            {
              value: "Transitional",
              label: "Transitional Housing",
            },
            {
              value: "Hospital",
              label: "Hospital / Facility",
            },
            {
              value: "Staying with others",
              label: "Staying with Others",
            },
            {
              value: "Other",
              label: "Other",
            },
          ],
        },
        {
          name: "currentSituationOther",
          label: "Living situation now (if other)",
          type: "text",
        },
        {
          name: "currentLocation",
          label: "Where are they right now",
          type: "text",
        },
        {
          name: "homelessSince",
          label: "Since (about)",
          type: "text",
        },
        {
          name: "householdSize",
          label: "Adults / children",
          type: "text",
        },
        {
          name: "homelessDuration",
          label: "How long without housing",
          type: "select",
          options: [
            "Less than 1 month",
            "1–3 months",
            "3–6 months",
            "6–12 months",
            "1–2 years",
            "2+ years",
            "Chronically homeless",
            "Under 6 months",
            "Over 12 months",
          ],
        },
        {
          name: "housingBarriers",
          label: "What gets in the way of housing",
          type: "check",
          options: [
            "No income",
            "Physical limits",
            "Mental health",
            "Substance use",
            "Legal issues",
            "No ID",
            "Other",
          ],
          wide: true,
        },
        {
          name: "housingBarriersOther",
          label: "What gets in the way of housing (if other)",
          type: "text",
        },
        {
          name: "recoveringFromIllness",
          label: "Healing from an illness, injury or surgery",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "recoveringFromWhat",
          label: "What",
          type: "text",
        },
        {
          name: "safetyConcerns",
          label: "Safety concerns",
          type: "check",
          options: [
            "Fall risk",
            "Trouble walking",
            "Behavioral instability",
            "Risk of returning to homelessness",
            "None",
          ],
          wide: true,
        },
        {
          name: "coedOk",
          label: "Co-ed home is OK (rooms are not shared)",
          type: "radio",
          options: ["Yes", "No"],
          wide: true,
        },
        {
          name: "otherRentHelp",
          label: "Another program helping with rent",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "otherRentHelpWhich",
          label: "Which",
          type: "text",
        },
        {
          name: "hasEcm",
          label: "Has an Enhanced Care Manager (ECM)",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "ecmContact",
          label: "Name / phone",
          type: "text",
        },
        {
          name: "ecmReferralOk",
          label: "Wants an ECM referral",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "stayNeeds",
          label: "Needs during the stay",
          type: "check",
          options: [
            "Housing navigation",
            "Benefits help",
            "Rides",
            "Appointment reminders",
            "Meals",
            "Basic supplies (hygiene, clothes, shoes)",
            "ECM referral",
          ],
          wide: true,
        },
        {
          name: "toldNoTimeLimit",
          label: "Told: no time limit on housing services, can ask for more time",
          type: "check",
          options: ["Yes"],
          wide: true,
        },
        {
          name: "understandsRecup",
          label: "Understands recuperative care is to heal and stay out of the hospital",
          type: "check",
          options: ["Yes"],
          wide: true,
        },
        {
          name: "recoveryGoal",
          label: "Recovery goal",
          type: "text",
        },
        {
          name: "housingGoal",
          label: "Housing goal",
          type: "text",
        },
        {
          name: "otherPriorities",
          label: "Other priorities",
          type: "text",
        },
        {
          name: "clientStrengths",
          label: "Client strengths (their own words)",
          type: "text",
        },
        {
          type: "note",
          label:
            "Recuperative care fit: needs both: healing from an illness or injury AND homeless or at risk. Not used in the last 12 months. Limit is 6 months in any 12. Get the plan's authorization before any service.",
        },
        {
          name: "recupFit",
          label: "Healing from an illness or injury",
          type: "check",
          options: [
            "Healing from an illness or injury",
            "Homeless or at risk",
            "Kaiser, Molina or IEHP member",
            "No recuperative care in the last 12 months",
            "Can do basic self-care",
          ],
          wide: true,
        },
        {
          name: "recupDetermination",
          label: "Decision",
          type: "radio",
          options: [
            "Can receive recuperative care",
            "Cannot receive recuperative care right now",
            "Not a recuperative care client",
          ],
        },
        {
          name: "recupReason",
          label: "Reason",
          type: "text",
        },
        {
          name: "clinicianReview",
          label: "Clinician review: name, license / NPI",
          type: "text",
        },
        {
          name: "clinicianReviewDate",
          label: "Date",
          type: "text",
        },
        {
          name: "assessorSignature",
          label: "Assessor signature",
          type: "text",
        },
        {
          name: "clientSignature",
          label: "Client signature",
          type: "text",
        },
        {
          type: "divider",
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
      key: "emergency",
      icon: "🆘",
      title: "Emergency Contacts & Referral Source",
      fields: [
        {
          name: "ec1Name",
          label: "Emergency Contact Name",
          type: "text",
          required: true,
          placeholder: "Full name",
        },
        {
          name: "ec1Relationship",
          label: "Relationship",
          type: "select",
          options: [
            "Parent",
            "Sibling",
            "Spouse / Partner",
            "Child",
            "Friend",
            "Case Manager",
            "Other",
          ],
        },
        {
          name: "ec1Phone",
          label: "EC Phone Number",
          type: "tel",
          required: true,
          placeholder: "(909) 000-0000",
        },
        {
          name: "ec2Name",
          label: "2nd Contact Name",
          type: "text",
          placeholder: "Full name",
        },
        {
          name: "ec2Relationship",
          label: "2nd Contact Relationship",
          type: "select",
          options: [
            "Parent",
            "Sibling",
            "Spouse / Partner",
            "Child",
            "Friend",
            "Case Manager",
            "Other",
          ],
        },
        {
          name: "ec2Phone",
          label: "2nd Contact Phone",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "ec1Email",
          label: "EC Email",
          type: "email",
          placeholder: "email@example.com",
        },
        {
          name: "ec2Email",
          label: "2nd Contact Email",
          type: "email",
          placeholder: "email@example.com",
        },
        {
          type: "heading",
          label: "Referral source",
        },
        {
          name: "referralType",
          label: "Referred by",
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
            "Health plan",
            "Other",
          ],
        },
        {
          name: "referralTypeOther",
          label: "Referred by (if other)",
          type: "text",
        },
        {
          name: "referralOrg",
          label: "Organization",
          type: "text",
          placeholder: "Organization name",
        },
        {
          name: "referralName",
          label: "Contact name",
          type: "text",
          placeholder: "Case manager / social worker name",
        },
        {
          name: "referralPhone",
          label: "Phone / email",
          type: "tel",
          placeholder: "(909) 000-0000",
        },
        {
          name: "referralReason",
          label: "Reason for the referral",
          type: "text",
        },
        {
          name: "otherCaseManager",
          label: "Other case manager / outreach worker (name, phone)",
          type: "text",
          wide: true,
        },
        {
          name: "referralTitle",
          label: "Title",
          type: "text",
          placeholder: "e.g. Housing Navigator, MSW",
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
      title: "Documents, Benefits, Move-in & Handoff",
      fields: [
        {
          type: "heading",
          label: "Documents · ID first, it unlocks the others",
        },
        {
          name: "docId",
          label: "California ID",
          type: "radio",
          options: ["Has it", "Lost", "Never had"],
        },
        {
          name: "docIdCopy",
          label: "Copy in Drive",
          type: "check",
          options: ["Copy in Drive"],
          wide: true,
        },
        {
          name: "docBirthCert",
          label: "Birth certificate",
          type: "radio",
          options: ["Has it", "Lost", "Never had"],
        },
        {
          name: "docBirthCertCopy",
          label: "Copy in Drive",
          type: "check",
          options: ["Copy in Drive"],
          wide: true,
        },
        {
          name: "docSsCard",
          label: "Social Security card",
          type: "radio",
          options: ["Has it", "Lost", "Never had"],
        },
        {
          name: "docSsCardCopy",
          label: "Copy in Drive",
          type: "check",
          options: ["Copy in Drive"],
          wide: true,
        },
        {
          type: "note",
          label:
            "DMV (800) 777-0133 · Riverside Clerk-Recorder (951) 486-7000, 2724 Gateway Dr · Social Security (800) 772-1213",
        },
        {
          type: "heading",
          label: "Food + benefits",
        },
        {
          name: "calFresh",
          label: "CalFresh",
          type: "radio",
          options: ["Has it", "Applied", "Needs to apply"],
        },
        {
          name: "needsClothes",
          label: "Needs clothes / basics",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          type: "note",
          label:
            "CalFresh: BenefitsCal.com or DPSS (877) 410-8827 · Food: Lutheran Social Services (951) 689-7847 · Salvation Army (951) 784-4490",
        },
        {
          type: "heading",
          label: "Move-in + handoff",
        },
        {
          name: "moveInDate",
          label: "Move-in date",
          type: "date",
        },
        {
          name: "prefLocation",
          label: "Home",
          type: "select",
          dynamic: "homes",
          blankLabel: "No preference / Any available",
        },
        {
          name: "bed",
          label: "Bed",
          type: "text",
        },
        {
          name: "rentAmount",
          label: "Rent $",
          type: "text",
        },
        {
          name: "foodPlan",
          label: "Food plan (+$300)",
          type: "radio",
          options: ["Yes", "No"],
        },
        {
          name: "rentPaid",
          label: "First month",
          type: "radio",
          options: ["Paid", "Prorated", "Not yet"],
        },
        {
          name: "handoffFrontDesk",
          label: "Front desk",
          type: "check",
          options: ["Chart filed in Drive", "Client manager told", "House manager told"],
          wide: true,
        },
        {
          name: "handoffHouseManager",
          label: "House manager",
          type: "check",
          options: ["Bed, cabinet, fridge ready", "Client agreement signed", "House rules covered"],
          wide: true,
        },
        {
          name: "handoffClientManager",
          label: "Client manager",
          type: "check",
          options: ["First visit done", "Appointments set", "Rides booked (5+ days ahead)"],
          wide: true,
        },
        {
          name: "noShow",
          label: "No-show / did not move in",
          type: "check",
          options: ["No-show / did not move in"],
          wide: true,
        },
        {
          name: "noShowNote",
          label: "Note",
          type: "text",
        },
        {
          name: "intakeNotes",
          label: "Notes",
          type: "textarea",
          wide: true,
          tall: true,
          placeholder:
            "Any additional observations, client demeanor, follow-up needed, placement urgency, specific room requests, etc...",
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
    // Layout only, like the divider: a sub-heading inside a section, and the
    // "transition to ..." lines printed on the paper assessment.
    if (field.type === "heading")
      return `<div class="if-subhead if-wide">${esc(field.label)}</div>`;
    if (field.type === "note") return `<div class="if-note if-wide">${esc(field.label)}</div>`;

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
