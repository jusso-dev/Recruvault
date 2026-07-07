import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// BetterAuth tables (both account worlds share one identity store; the
// `accountType` field separates organisation-side users from job seekers).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // "org" (recruiter-side) or "seeker" (job seeker). Job seekers are never
  // members of a recruiter tenant.
  accountType: text("account_type").notNull().default("seeker"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_i_d").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: timestamp("created_at"),
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orgRole = pgEnum("org_role", [
  "owner",
  "admin",
  "recruiter",
  "reviewer",
  "compliance",
]);

export const requestStatus = pgEnum("request_status", [
  "draft",
  "open",
  "closing_soon",
  "closed",
  "archived",
]);

export const submissionStatus = pgEnum("submission_status", [
  "started",
  "received",
  "under_review",
  "accepted",
  "follow_up",
]);

export const fieldType = pgEnum("field_type", [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_select",
  "multi_select",
  "boolean",
  "file_upload",
  "consent",
]);

export const scanStatus = pgEnum("scan_status", [
  "pending",
  "scanning",
  "clean",
  "infected",
  "error",
]);

export const documentKind = pgEnum("document_kind", ["jd", "nda", "evidence"]);

export const jdViewMode = pgEnum("jd_view_mode", ["view_only", "allow_download"]);

export const actorType = pgEnum("actor_type", [
  "org_user",
  "candidate",
  "link_responder",
  "system",
]);

export const tokenPurpose = pgEnum("token_purpose", ["request_link"]);

export const deliveryChannel = pgEnum("delivery_channel", ["email", "sms"]);

export const deliveryStatus = pgEnum("delivery_status", [
  "queued",
  "sent",
  "opened",
  "started",
  "submitted",
  "bounced",
  "failed",
]);

export const sendingMode = pgEnum("sending_mode", ["shared", "custom_domain"]);

export const consentType = pgEnum("consent_type", ["collection", "nda"]);

// ---------------------------------------------------------------------------
// Encryption key registry. Every encrypted row stores a dek_id pointing here.
// Deletion is a crypto-shred: null the wrapped key so ciphertext is
// unrecoverable, then remove rows and objects.
// ---------------------------------------------------------------------------

export const dataKeys = pgTable("data_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Base64 DEK wrapped by the KMS CMK (or local KEK in dev). Null once shredded.
  wrappedKey: text("wrapped_key"),
  keySource: text("key_source").notNull(), // "kms" | "local"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  shreddedAt: timestamp("shredded_at"),
});

// ---------------------------------------------------------------------------
// Organisation world
// ---------------------------------------------------------------------------

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  branding: jsonb("branding")
    .$type<{ logoUrl?: string; primaryColor?: string; senderName?: string }>()
    .notNull()
    .default({}),
  sendingMode: sendingMode("sending_mode").notNull().default("shared"),
  sendingDomain: text("sending_domain"),
  sendingDomainVerifiedAt: timestamp("sending_domain_verified_at"),
  // Days after submission before automatic purge. Enforced by the retention job.
  retentionDays: integer("retention_days").notNull().default(90),
  purgeOnClose: boolean("purge_on_close").notNull().default(false),
  plan: text("plan").notNull().default("solo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_idx").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Job seeker world
// ---------------------------------------------------------------------------

export const candidateAccounts = pgTable("candidate_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  phone: text("phone"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const walletItems = pgTable(
  "wallet_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateAccountId: uuid("candidate_account_id")
      .notNull()
      .references(() => candidateAccounts.id, { onDelete: "cascade" }),
    // Semantic key from the field library, e.g. "clearance_level", "citizenship".
    type: text("type").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    dekId: uuid("dek_id")
      .notNull()
      .references(() => dataKeys.id),
    // Always false in this release: wallet data is self-declared, never
    // presented as verified. Verification is a later integration.
    verified: boolean("verified").notNull().default(false),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wallet_items_owner_type_idx").on(t.candidateAccountId, t.type)],
);

export const walletDocuments = pgTable("wallet_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  candidateAccountId: uuid("candidate_account_id")
    .notNull()
    .references(() => candidateAccounts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // passport | driver_licence | other evidence
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull(),
  checksum: text("checksum"),
  scanStatus: scanStatus("scan_status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// The consent ledger: every share of a wallet item or document into a
// submission is recorded and individually revocable for future use.
export const walletShares = pgTable(
  "wallet_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateAccountId: uuid("candidate_account_id")
      .notNull()
      .references(() => candidateAccounts.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    walletItemId: uuid("wallet_item_id").references(() => walletItems.id, {
      onDelete: "set null",
    }),
    walletDocumentId: uuid("wallet_document_id").references(() => walletDocuments.id, {
      onDelete: "set null",
    }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    consentedAt: timestamp("consented_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("wallet_shares_owner_idx").on(t.candidateAccountId)],
);

export const savedRoles = pgTable(
  "saved_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateAccountId: uuid("candidate_account_id")
      .notNull()
      .references(() => candidateAccounts.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_roles_unique_idx").on(t.candidateAccountId, t.requestId)],
);

// ---------------------------------------------------------------------------
// Requests, fields, documents, submissions
// ---------------------------------------------------------------------------

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    title: text("title").notNull(),
    description: text("description"),
    status: requestStatus("status").notNull().default("draft"),
    // Listed = discoverable to seekers the org engages with. Never a public board.
    listed: boolean("listed").notNull().default(false),
    expiresAt: timestamp("expires_at"),
    consentRequired: boolean("consent_required").notNull().default(true),
    consentNoticeVersion: text("consent_notice_version").notNull().default("v1"),
    consentPurpose: text("consent_purpose"),
    ndaDocumentId: uuid("nda_document_id"),
    jdDocumentId: uuid("jd_document_id"),
    jdViewMode: jdViewMode("jd_view_mode").notNull().default("view_only"),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("requests_org_idx").on(t.orgId)],
);

export const requestFields = pgTable(
  "request_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    // Semantic key from the field library ("clearance_level", "custom", ...).
    // Drives wallet pre-fill and validation.
    key: text("key").notNull(),
    type: fieldType("type").notNull(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    required: boolean("required").notNull().default(true),
    options: jsonb("options").$type<string[]>(),
    // Sensitive fields get field-level encryption and stricter access rules.
    sensitive: boolean("sensitive").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("request_fields_request_idx").on(t.requestId)],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organisations.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes"),
    storageKey: text("storage_key").notNull(),
    checksum: text("checksum"),
    scanStatus: scanStatus("scan_status").notNull().default("pending"),
    watermarkRequired: boolean("watermark_required").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("documents_org_idx").on(t.orgId)],
);

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    // Null for link-only responders without a wallet account. Both paths work.
    candidateAccountId: uuid("candidate_account_id").references(
      () => candidateAccounts.id,
      { onDelete: "set null" },
    ),
    accessTokenId: uuid("access_token_id").references(() => accessTokens.id),
    responderEmail: text("responder_email"),
    status: submissionStatus("status").notNull().default("started"),
    submittedAt: timestamp("submitted_at"),
    // Set when the retention job purges this submission's PII.
    purgedAt: timestamp("purged_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("submissions_request_idx").on(t.requestId)],
);

export const submissionValues = pgTable(
  "submission_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => requestFields.id, { onDelete: "cascade" }),
    valueEncrypted: text("value_encrypted").notNull(),
    dekId: uuid("dek_id")
      .notNull()
      .references(() => dataKeys.id),
  },
  (t) => [uniqueIndex("submission_values_unique_idx").on(t.submissionId, t.fieldId)],
);

export const submissionDocuments = pgTable("submission_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  fieldId: uuid("field_id")
    .notNull()
    .references(() => requestFields.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id),
});

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  type: consentType("type").notNull(),
  noticeVersion: text("notice_version").notNull(),
  acceptedAt: timestamp("accepted_at").notNull().defaultNow(),
  ip: text("ip"),
});

// Reviewer access: submissions explicitly shared with an org user.
export const submissionShares = pgTable(
  "submission_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("submission_shares_unique_idx").on(t.submissionId, t.userId)],
);

// ---------------------------------------------------------------------------
// Secure links, OTP, delivery
// ---------------------------------------------------------------------------

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    // SHA-256 of the opaque high-entropy token. The raw token never touches the DB.
    tokenHash: text("token_hash").notNull().unique(),
    purpose: tokenPurpose("purpose").notNull().default("request_link"),
    recipientEmail: text("recipient_email").notNull(),
    recipientPhone: text("recipient_phone"),
    expiresAt: timestamp("expires_at").notNull(),
    // OTP step-up: hash of the current one-time code sent to the recipient.
    otpHash: text("otp_hash"),
    otpExpiresAt: timestamp("otp_expires_at"),
    otpAttempts: integer("otp_attempts").notNull().default(0),
    verifiedAt: timestamp("verified_at"),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("access_tokens_request_idx").on(t.requestId)],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    accessTokenId: uuid("access_token_id")
      .notNull()
      .references(() => accessTokens.id, { onDelete: "cascade" }),
    channel: deliveryChannel("channel").notNull(),
    recipient: text("recipient").notNull(),
    status: deliveryStatus("status").notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("deliveries_request_idx").on(t.requestId)],
);

// Hard-bounced or complained addresses are suppressed from future sends.
export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Per-tenant SMS usage tracking.
export const smsEvents = pgTable(
  "sms_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // Last 3 digits only; never store the full number here.
    recipientSuffix: text("recipient_suffix").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sms_events_org_idx").on(t.orgId)],
);

// ---------------------------------------------------------------------------
// Templates and reference data
// ---------------------------------------------------------------------------

export const requestTemplates = pgTable("request_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Admin-configurable controlled vocabularies. org_id null = platform seed.
// Seeded with current AGSVA clearance levels; the framework is mid-transition
// (PV phasing out in favour of TS-PA) so this is data, never hardcoded.
export const referenceValues = pgTable(
  "reference_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organisations.id, { onDelete: "cascade" }),
    category: text("category").notNull(), // clearance_level | clearance_status | citizenship | right_to_work | police_check_status
    code: text("code").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("reference_values_category_idx").on(t.category)],
);

// ---------------------------------------------------------------------------
// Audit trail: append-only, hash-chained so tampering is detectable.
// Events reference targets by id, never by value — no PII in the log.
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for candidate/global events not tied to a tenant.
    orgId: uuid("org_id").references(() => organisations.id),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    // Sequence within the chain (org-scoped, or the global chain when orgId is null).
    seq: integer("seq").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_org_idx").on(t.orgId, t.seq),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
  ],
);
