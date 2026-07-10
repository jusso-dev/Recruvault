/**
 * The field library: the deliberately small set of facts a recruiter can ask
 * for when creating a role. Recruvault does not collect identity documents,
 * police checks, citizenship evidence, or right-to-work documents.
 *
 * Clearance levels are seeded with current AGSVA values but are an
 * admin-configurable reference list (reference_values table), never hardcoded
 * into logic — the framework is mid-transition (PV phasing out, TS-PA in).
 * Confirm current values with AGSVA before each release and update the seed.
 */

export type FieldTypeName =
  | "short_text"
  | "long_text"
  | "number"
  | "date"
  | "single_select"
  | "multi_select"
  | "boolean"
  | "file_upload"
  | "consent";

export interface FieldDefinition {
  key: string;
  type: FieldTypeName;
  label: string;
  helpText?: string;
  sensitive: boolean;
  /** Wallet item type this field can pre-fill from, if any. */
  walletType?: string;
  /** reference_values category supplying options, for select types. */
  referenceCategory?: string;
}

export const FIELD_LIBRARY: FieldDefinition[] = [
  {
    key: "clearance_level",
    type: "single_select",
    label: "Security clearance level",
    helpText: "Your current AGSVA clearance level.",
    sensitive: true,
    walletType: "clearance_level",
    referenceCategory: "clearance_level",
  },
  {
    key: "clearance_id",
    type: "short_text",
    label: "Security clearance ID",
    helpText: "Your AGSVA clearance identifier.",
    sensitive: true,
    walletType: "clearance_id",
  },
  {
    key: "resume",
    type: "file_upload",
    label: "Resume / CV",
    helpText: "Your current resume or CV (PDF or Word).",
    sensitive: false,
    walletType: "resume",
  },
  {
    key: "cover_letter",
    type: "file_upload",
    label: "Cover letter / suitability statement",
    helpText: "A tailored cover letter or suitability statement (PDF or Word).",
    sensitive: false,
    walletType: "cover_letter",
  },
];

export function fieldDefinition(key: string): FieldDefinition | undefined {
  return FIELD_LIBRARY.find((f) => f.key === key);
}

/**
 * Shape stored in request_templates.definition (jsonb). Written by
 * createRequest when "save as template" is checked; read back to pre-fill the
 * new-request form.
 */
export interface RequestTemplateDefinition {
  title: string;
  description: string | null;
  location?: string | null;
  employmentType?: string | null;
  workArrangement?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryPeriod?: string | null;
  skills?: string[];
  libraryKeys: string[];
  customLabels: string[];
  jdViewMode: "view_only" | "allow_download";
}

/** Wallet item types a seeker can store, derived from the field library. */
export const WALLET_ITEM_TYPES = FIELD_LIBRARY.filter(
  (f) => f.walletType && f.type !== "file_upload",
).map((f) => ({ type: f.walletType!, label: f.label, fieldKey: f.key }));

// ---------------------------------------------------------------------------
// Reference data seed. AGSVA levels current as at mid-2026 — the PV → TS-PA
// transition is live, so review before each release.
// ---------------------------------------------------------------------------

export interface ReferenceSeed {
  category: string;
  code: string;
  label: string;
  description?: string;
  sortOrder: number;
}

export const REFERENCE_SEED: ReferenceSeed[] = [
  // AGSVA clearance levels
  {
    category: "clearance_level",
    code: "baseline",
    label: "Baseline",
    description: "Access up to and including PROTECTED.",
    sortOrder: 1,
  },
  {
    category: "clearance_level",
    code: "nv1",
    label: "Negative Vetting 1 (NV1)",
    description: "Access up to and including SECRET.",
    sortOrder: 2,
  },
  {
    category: "clearance_level",
    code: "nv2",
    label: "Negative Vetting 2 (NV2)",
    description: "Access up to and including TOP SECRET.",
    sortOrder: 3,
  },
  {
    category: "clearance_level",
    code: "pv",
    label: "Positive Vetting (PV)",
    description:
      "Up to and including TOP SECRET, including caveated and code word information. Being phased out in favour of TS-PA.",
    sortOrder: 4,
  },
  {
    category: "clearance_level",
    code: "tspa",
    label: "Top Secret-Privileged Access (TS-PA)",
    description:
      "The highest level, replacing PV. Managed by the ASIO TS-PA Vetting Authority.",
    sortOrder: 5,
  },
  {
    category: "clearance_level",
    code: "none",
    label: "None",
    description: "No clearance held.",
    sortOrder: 6,
  },
];

// Upload constraints for controlled document uploads.
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Controlled uploads may be PDFs or common image formats.
export const UPLOAD_ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

// Job descriptions, resumes, and cover letters are documents, so they accept Word (.docx).
export const JD_ALLOWED_TYPES = ["application/pdf", DOCX];
export const RESUME_ALLOWED_TYPES = ["application/pdf", DOCX];

export const WALLET_DOCUMENT_TYPES = [
  { type: "resume", label: "Resume / CV", group: "career" },
  { type: "cover_letter", label: "Cover letter / suitability statement", group: "career" },
] as const;

export const CAREER_DOCUMENT_KINDS = new Set<string>(
  WALLET_DOCUMENT_TYPES.filter((type) => type.group === "career").map((type) => type.type),
);

export function allowedTypesForWalletDocument(kind: string): string[] {
  if (["resume", "cover_letter"].includes(kind)) {
    return RESUME_ALLOWED_TYPES;
  }
  return [];
}

/**
 * Allowed content types for a requested file field, by field key. Resume
 * accepts PDF or Word; everything else stays PDF/image only.
 */
export function allowedTypesForField(key: string): string[] {
  return ["resume", "cover_letter"].includes(key)
    ? RESUME_ALLOWED_TYPES
    : UPLOAD_ALLOWED_TYPES;
}

// The complete set a recruiter may ask for on a new role.
export const ROLE_REQUEST_FIELD_KEYS = [
  "clearance_level",
  "clearance_id",
  "resume",
  "cover_letter",
] as const;

// Career documents default on; clearance details remain optional per role.
export const DEFAULT_REQUEST_FIELD_KEYS = ["resume", "cover_letter"];
