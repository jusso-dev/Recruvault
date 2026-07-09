/**
 * The field library: typed fields a recruiter can request. Clearance and
 * identity fields are first-class.
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
  // --- Clearance ---
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
    key: "clearance_status",
    type: "single_select",
    label: "Clearance status",
    sensitive: true,
    walletType: "clearance_status",
    referenceCategory: "clearance_status",
  },
  {
    key: "clearance_grant_date",
    type: "date",
    label: "Clearance grant date",
    sensitive: true,
    walletType: "clearance_grant_date",
  },
  {
    key: "clearance_expiry_date",
    type: "date",
    label: "Clearance expiry date",
    sensitive: true,
    walletType: "clearance_expiry_date",
  },
  {
    key: "clearance_revalidation_date",
    type: "date",
    label: "Next revalidation date",
    sensitive: true,
    walletType: "clearance_revalidation_date",
  },
  {
    key: "sponsoring_agency",
    type: "short_text",
    label: "Sponsoring agency or department",
    helpText: "Clearances are sponsored — which agency or department sponsors yours?",
    sensitive: true,
    walletType: "sponsoring_agency",
  },
  // --- Identity and eligibility ---
  {
    key: "citizenship",
    type: "single_select",
    label: "Citizenship",
    helpText:
      "Australian citizenship is the base eligibility requirement for a clearance.",
    sensitive: true,
    walletType: "citizenship",
    referenceCategory: "citizenship",
  },
  {
    key: "photo_id",
    type: "file_upload",
    label: "Government photo ID",
    helpText: "Passport or driver licence. Uploaded securely, never emailed.",
    sensitive: true,
    walletType: "photo_id",
  },
  {
    key: "id_document_type",
    type: "single_select",
    label: "ID document type",
    sensitive: true,
    walletType: "id_document_type",
    referenceCategory: "id_document_type",
  },
  {
    key: "id_document_number",
    type: "short_text",
    label: "ID document number",
    sensitive: true,
    walletType: "id_document_number",
  },
  {
    key: "id_document_expiry",
    type: "date",
    label: "ID document expiry",
    sensitive: true,
    walletType: "id_document_expiry",
  },
  {
    key: "right_to_work",
    type: "single_select",
    label: "Right to work / visa status",
    sensitive: true,
    walletType: "right_to_work",
    referenceCategory: "right_to_work",
  },
  {
    key: "police_check_status",
    type: "single_select",
    label: "Police check status",
    sensitive: true,
    walletType: "police_check_status",
    referenceCategory: "police_check_status",
  },
  {
    key: "police_check_date",
    type: "date",
    label: "Police check date",
    sensitive: true,
    walletType: "police_check_date",
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
  // Clearance status
  { category: "clearance_status", code: "active", label: "Active", sortOrder: 1 },
  { category: "clearance_status", code: "lapsed", label: "Lapsed", sortOrder: 2 },
  { category: "clearance_status", code: "in_progress", label: "In progress", sortOrder: 3 },
  { category: "clearance_status", code: "sponsored", label: "Sponsored", sortOrder: 4 },
  { category: "clearance_status", code: "ceased", label: "Ceased", sortOrder: 5 },
  // Citizenship
  { category: "citizenship", code: "au_citizen", label: "Australian citizen", sortOrder: 1 },
  {
    category: "citizenship",
    code: "au_pr",
    label: "Australian permanent resident",
    sortOrder: 2,
  },
  { category: "citizenship", code: "dual", label: "Dual citizen (incl. Australian)", sortOrder: 3 },
  { category: "citizenship", code: "other", label: "Other", sortOrder: 4 },
  // Right to work
  { category: "right_to_work", code: "citizen", label: "Citizen — unrestricted", sortOrder: 1 },
  { category: "right_to_work", code: "pr", label: "Permanent resident — unrestricted", sortOrder: 2 },
  { category: "right_to_work", code: "visa_unrestricted", label: "Visa — unrestricted work rights", sortOrder: 3 },
  { category: "right_to_work", code: "visa_restricted", label: "Visa — restricted work rights", sortOrder: 4 },
  { category: "right_to_work", code: "none", label: "No current right to work", sortOrder: 5 },
  // Police check
  { category: "police_check_status", code: "clear", label: "Completed — no disclosable outcomes", sortOrder: 1 },
  { category: "police_check_status", code: "disclosed", label: "Completed — disclosable outcomes", sortOrder: 2 },
  { category: "police_check_status", code: "in_progress", label: "In progress", sortOrder: 3 },
  { category: "police_check_status", code: "not_held", label: "Not held", sortOrder: 4 },
  // ID document types
  { category: "id_document_type", code: "passport", label: "Passport", sortOrder: 1 },
  { category: "id_document_type", code: "driver_licence", label: "Driver licence", sortOrder: 2 },
];

// Upload constraints for controlled document uploads.
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const UPLOAD_ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];
