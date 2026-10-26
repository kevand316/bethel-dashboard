// IntakeFields.gs: GENERATED from bethel-dashboard/lib/intake-form.js by
// tools/export-intake-fields.mjs. Do not edit by hand.
const INTAKE_SECTIONS = [
  {
    "title": "Personal Information",
    "fields": [
      {
        "name": "firstName",
        "label": "First Name",
        "type": "text",
        "required": true
      },
      {
        "name": "lastName",
        "label": "Last Name",
        "type": "text",
        "required": true
      },
      {
        "name": "dob",
        "label": "Date of Birth",
        "type": "date",
        "required": true
      },
      {
        "name": "gender",
        "label": "Gender",
        "type": "select",
        "required": false,
        "options": [
          "Male",
          "Female",
          "Non-binary",
          "Prefer not to say",
          "Other"
        ]
      },
      {
        "name": "phone",
        "label": "Phone Number",
        "type": "tel",
        "required": true
      },
      {
        "name": "phoneAlt",
        "label": "Alternate Phone",
        "type": "tel",
        "required": false
      },
      {
        "name": "email",
        "label": "Email Address",
        "type": "email",
        "required": false
      },
      {
        "name": "ssn",
        "label": "Social Security Number",
        "type": "text",
        "required": true
      },
      {
        "name": "ethnicity",
        "label": "Ethnicity",
        "type": "select",
        "required": false,
        "options": [
          "Hispanic / Latino",
          "Black / African American",
          "White / Caucasian",
          "Asian / Pacific Islander",
          "Native American",
          "Two or More Races",
          "Other",
          "Prefer not to say"
        ]
      },
      {
        "name": "language",
        "label": "Primary Language",
        "type": "select",
        "required": false,
        "options": [
          "English",
          "Spanish",
          "Other"
        ]
      }
    ]
  },
  {
    "title": "Housing History & Current Situation",
    "fields": [
      {
        "name": "currentSituation",
        "label": "Current Living Situation",
        "type": "radio",
        "required": true,
        "options": [
          "Homeless",
          "Shelter",
          "Transitional",
          "Hospital",
          "Staying with others",
          "Other"
        ]
      },
      {
        "name": "homelessDuration",
        "label": "How long without stable housing?",
        "type": "select",
        "required": false,
        "options": [
          "Less than 1 month",
          "1–3 months",
          "3–6 months",
          "6–12 months",
          "1–2 years",
          "2+ years",
          "Chronically homeless"
        ]
      },
      {
        "name": "lastAddress",
        "label": "Last Permanent Address (City)",
        "type": "text",
        "required": false
      },
      {
        "name": "housingLossReason",
        "label": "Reason for Losing Housing",
        "type": "select",
        "required": false,
        "options": [
          "Eviction",
          "Financial",
          "Domestic Violence",
          "Substance Use",
          "Mental Health",
          "Incarceration",
          "Hospitalization",
          "Other"
        ]
      },
      {
        "name": "moveInDate",
        "label": "Desired Move-In Date",
        "type": "date",
        "required": false
      },
      {
        "name": "prefLocation",
        "label": "Preferred Home",
        "type": "select",
        "required": false,
        "dynamic": "homes"
      },
      {
        "name": "evictionHistory",
        "label": "Previous Evictions or Landlord Issues?",
        "type": "textarea",
        "required": false
      }
    ]
  },
  {
    "title": "Income & Benefits",
    "fields": [
      {
        "name": "income",
        "label": "Income Sources (select all that apply)",
        "type": "check",
        "required": false,
        "options": [
          "SSI",
          "SSDI",
          "CalWORKs",
          "General Relief",
          "Employment",
          "Veterans Benefits",
          "Pension",
          "None"
        ]
      },
      {
        "name": "monthlyIncome",
        "label": "Total Monthly Income",
        "type": "text",
        "required": false
      },
      {
        "name": "ssiStatus",
        "label": "SSI/SSDI Application Status",
        "type": "select",
        "required": false,
        "options": [
          "Currently Receiving",
          "Pending / Applied",
          "Denied – Appealing",
          "Never Applied",
          "Needs Assistance Applying"
        ]
      },
      {
        "name": "benefits",
        "label": "Current Benefits (select all that apply)",
        "type": "check",
        "required": false,
        "options": [
          "Medi-Cal",
          "Medicare",
          "CalFresh",
          "VA Benefits",
          "IHSS",
          "None"
        ]
      },
      {
        "name": "mediCalStatus",
        "label": "Medi-Cal Status",
        "type": "select",
        "required": false,
        "options": [
          "Active",
          "Pending",
          "Lapsed / Needs Renewal",
          "Never Had",
          "Needs Assistance Applying"
        ]
      },
      {
        "name": "mediCalId",
        "label": "Medi-Cal ID Number",
        "type": "text",
        "required": false
      },
      {
        "name": "repPayee",
        "label": "Has Rep Payee?",
        "type": "select",
        "required": false,
        "options": [
          "Yes",
          "No",
          "Needs One"
        ]
      }
    ]
  },
  {
    "title": "Medical & Mental Health History",
    "fields": [
      {
        "name": "mhDx",
        "label": "Mental Health Diagnoses (select all that apply)",
        "type": "check",
        "required": false,
        "options": [
          "Depression",
          "Bipolar",
          "Schizophrenia",
          "PTSD",
          "Anxiety",
          "ADHD",
          "TBI",
          "Other MH",
          "None"
        ]
      },
      {
        "name": "substanceUse",
        "label": "Substance Use History (select all that apply)",
        "type": "check",
        "required": false,
        "options": [
          "Alcohol",
          "Marijuana",
          "Meth",
          "Opioids",
          "Crack/Cocaine",
          "In Recovery",
          "None"
        ]
      },
      {
        "name": "lastUseDate",
        "label": "Date of Last Use",
        "type": "date",
        "required": false
      },
      {
        "name": "substanceTreatment",
        "label": "Currently in Treatment / Sober Living?",
        "type": "select",
        "required": false,
        "options": [
          "Yes – Outpatient Program",
          "Yes – AA / NA",
          "Yes – MAT (Medication Assisted)",
          "Completed Treatment",
          "No – Not in Treatment",
          "N/A"
        ]
      },
      {
        "name": "onMedication",
        "label": "Currently on Medication?",
        "type": "select",
        "required": false,
        "options": [
          "Yes – Psychiatric",
          "Yes – Medical",
          "Yes – Both",
          "No"
        ]
      },
      {
        "name": "medCompliant",
        "label": "Medication Compliant?",
        "type": "select",
        "required": false,
        "options": [
          "Yes",
          "No",
          "N/A – No Medications"
        ]
      },
      {
        "name": "mhTreatment",
        "label": "Currently in Mental Health Treatment?",
        "type": "select",
        "required": false,
        "options": [
          "Yes – Outpatient",
          "Yes – Case Management",
          "Recently Discharged",
          "No",
          "Needs Referral"
        ]
      },
      {
        "name": "physicalHealth",
        "label": "Physical Health / Disabilities",
        "type": "textarea",
        "required": false
      },
      {
        "name": "adlIndependent",
        "label": "Can Complete All ADLs Independently?",
        "type": "select",
        "required": false,
        "options": [
          "Yes",
          "No – Needs Some Help",
          "No – Needs Significant Help"
        ]
      },
      {
        "name": "recentHospital",
        "label": "Recent Hospitalization?",
        "type": "select",
        "required": false,
        "options": [
          "Yes – Psychiatric",
          "Yes – Medical",
          "Yes – Both",
          "No"
        ]
      },
      {
        "name": "dischargingFrom",
        "label": "Discharging From",
        "type": "text",
        "required": false
      }
    ]
  },
  {
    "title": "Criminal Background",
    "fields": [
      {
        "name": "hasCriminalHistory",
        "label": "Any Criminal History?",
        "type": "radio",
        "required": true,
        "options": [
          "No",
          "Yes - Misdemeanor",
          "Yes - Felony",
          "Yes - Both"
        ]
      },
      {
        "name": "probationParole",
        "label": "Currently on Probation or Parole?",
        "type": "select",
        "required": false,
        "options": [
          "No",
          "Yes – Probation",
          "Yes – Parole",
          "Yes – Both"
        ]
      },
      {
        "name": "poName",
        "label": "Probation / Parole Officer Name",
        "type": "text",
        "required": false
      },
      {
        "name": "poPhone",
        "label": "PO Phone Number",
        "type": "tel",
        "required": false
      },
      {
        "name": "sexOffender",
        "label": "Registered Sex Offender?",
        "type": "radio",
        "required": true,
        "options": [
          "Yes",
          "No"
        ]
      },
      {
        "name": "arsonHistory",
        "label": "Any Arson History?",
        "type": "radio",
        "required": false,
        "options": [
          "Yes",
          "No"
        ]
      },
      {
        "name": "criminalNotes",
        "label": "Notes on Criminal History",
        "type": "textarea",
        "required": false
      }
    ]
  },
  {
    "title": "Emergency Contacts & References",
    "fields": [
      {
        "name": "ec1Name",
        "label": "Emergency Contact Name",
        "type": "text",
        "required": true
      },
      {
        "name": "ec1Relationship",
        "label": "Relationship",
        "type": "select",
        "required": false,
        "options": [
          "Parent",
          "Sibling",
          "Spouse / Partner",
          "Child",
          "Friend",
          "Case Manager",
          "Other"
        ]
      },
      {
        "name": "ec1Phone",
        "label": "EC Phone Number",
        "type": "tel",
        "required": true
      },
      {
        "name": "ec1Email",
        "label": "EC Email",
        "type": "email",
        "required": false
      },
      {
        "name": "ec2Name",
        "label": "2nd Contact Name",
        "type": "text",
        "required": false
      },
      {
        "name": "ec2Relationship",
        "label": "2nd Contact Relationship",
        "type": "select",
        "required": false,
        "options": [
          "Parent",
          "Sibling",
          "Spouse / Partner",
          "Child",
          "Friend",
          "Case Manager",
          "Other"
        ]
      },
      {
        "name": "ec2Phone",
        "label": "2nd Contact Phone",
        "type": "tel",
        "required": false
      },
      {
        "name": "ec2Email",
        "label": "2nd Contact Email",
        "type": "email",
        "required": false
      }
    ]
  },
  {
    "title": "Referral Source",
    "fields": [
      {
        "name": "referralType",
        "label": "Referral Type",
        "type": "select",
        "required": true,
        "options": [
          "Hospital / ER",
          "Mental Health Clinic",
          "Nonprofit / CBO",
          "Social Worker",
          "Case Manager",
          "Housing Navigator",
          "Probation / Parole",
          "Self-Referral",
          "211",
          "Other"
        ]
      },
      {
        "name": "referralOrg",
        "label": "Referring Organization",
        "type": "text",
        "required": false
      },
      {
        "name": "referralName",
        "label": "Referring Contact Name",
        "type": "text",
        "required": false
      },
      {
        "name": "referralTitle",
        "label": "Title",
        "type": "text",
        "required": false
      },
      {
        "name": "referralPhone",
        "label": "Referral Phone",
        "type": "tel",
        "required": false
      },
      {
        "name": "referralEmail",
        "label": "Referral Email",
        "type": "email",
        "required": false
      },
      {
        "name": "referralNotes",
        "label": "Referral Notes",
        "type": "textarea",
        "required": false
      }
    ]
  },
  {
    "title": "Staff Notes",
    "fields": [
      {
        "name": "staffName",
        "label": "Staff Member Completing Intake",
        "type": "text",
        "required": false
      },
      {
        "name": "callDateTime",
        "label": "Date / Time of Intake",
        "type": "datetime-local",
        "required": false
      },
      {
        "name": "intakeNotes",
        "label": "Intake Notes",
        "type": "textarea",
        "required": false
      },
      {
        "name": "placementDecision",
        "label": "Placement Decision",
        "type": "radio",
        "required": false,
        "options": [
          "Approved",
          "Pending Review",
          "Waitlist",
          "Denied"
        ]
      }
    ]
  }
];
const INTAKE_FIELDS = INTAKE_SECTIONS.reduce((all, s) => all.concat(s.fields), []);
