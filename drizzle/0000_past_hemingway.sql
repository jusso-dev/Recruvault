CREATE TYPE "public"."actor_type" AS ENUM('org_user', 'candidate', 'link_responder', 'system');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('collection', 'nda');--> statement-breakpoint
CREATE TYPE "public"."delivery_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'sent', 'opened', 'started', 'submitted', 'bounced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('jd', 'nda', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."field_type" AS ENUM('short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'boolean', 'file_upload', 'consent');--> statement-breakpoint
CREATE TYPE "public"."jd_view_mode" AS ENUM('view_only', 'allow_download');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'recruiter', 'reviewer', 'compliance');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('draft', 'open', 'closing_soon', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'scanning', 'clean', 'infected', 'error');--> statement-breakpoint
CREATE TYPE "public"."sending_mode" AS ENUM('shared', 'custom_domain');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('started', 'received', 'under_review', 'accepted', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."token_purpose" AS ENUM('request_link');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "token_purpose" DEFAULT 'request_link' NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_phone" text,
	"expires_at" timestamp NOT NULL,
	"otp_hash" text,
	"otp_expires_at" timestamp,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"ip" text,
	"user_agent" text,
	"seq" integer NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"phone" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_accounts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"type" "consent_type" NOT NULL,
	"notice_version" text NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "data_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wrapped_key" text,
	"key_source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"shredded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"access_token_id" uuid NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"recipient" text NOT NULL,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" "document_kind" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer,
	"storage_key" text NOT NULL,
	"checksum" text,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"watermark_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sending_mode" "sending_mode" DEFAULT 'shared' NOT NULL,
	"sending_domain" text,
	"sending_domain_verified_at" timestamp,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"purge_on_close" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_i_d" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "reference_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"category" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" "field_type" NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"required" boolean DEFAULT true NOT NULL,
	"options" jsonb,
	"sensitive" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "request_status" DEFAULT 'draft' NOT NULL,
	"listed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"consent_required" boolean DEFAULT true NOT NULL,
	"consent_notice_version" text DEFAULT 'v1' NOT NULL,
	"consent_purpose" text,
	"nda_document_id" uuid,
	"jd_document_id" uuid,
	"jd_view_mode" "jd_view_mode" DEFAULT 'view_only' NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_account_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sms_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_suffix" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"document_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value_encrypted" text NOT NULL,
	"dek_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"candidate_account_id" uuid,
	"access_token_id" uuid,
	"responder_email" text,
	"status" "submission_status" DEFAULT 'started' NOT NULL,
	"submitted_at" timestamp,
	"purged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"account_type" text DEFAULT 'seeker' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"checksum" text,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"dek_id" uuid NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_account_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"wallet_item_id" uuid,
	"wallet_document_id" uuid,
	"org_id" uuid NOT NULL,
	"consented_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_accounts" ADD CONSTRAINT "candidate_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_access_token_id_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "public"."access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_values" ADD CONSTRAINT "reference_values_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_fields" ADD CONSTRAINT "request_fields_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_templates" ADD CONSTRAINT "request_templates_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_roles" ADD CONSTRAINT "saved_roles_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_roles" ADD CONSTRAINT "saved_roles_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_events" ADD CONSTRAINT "sms_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_documents" ADD CONSTRAINT "submission_documents_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_documents" ADD CONSTRAINT "submission_documents_field_id_request_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."request_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_documents" ADD CONSTRAINT "submission_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_shares" ADD CONSTRAINT "submission_shares_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_shares" ADD CONSTRAINT "submission_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_values" ADD CONSTRAINT "submission_values_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_values" ADD CONSTRAINT "submission_values_field_id_request_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."request_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_values" ADD CONSTRAINT "submission_values_dek_id_data_keys_id_fk" FOREIGN KEY ("dek_id") REFERENCES "public"."data_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_access_token_id_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "public"."access_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_documents" ADD CONSTRAINT "wallet_documents_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_items" ADD CONSTRAINT "wallet_items_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_items" ADD CONSTRAINT "wallet_items_dek_id_data_keys_id_fk" FOREIGN KEY ("dek_id") REFERENCES "public"."data_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_wallet_item_id_wallet_items_id_fk" FOREIGN KEY ("wallet_item_id") REFERENCES "public"."wallet_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_wallet_document_id_wallet_documents_id_fk" FOREIGN KEY ("wallet_document_id") REFERENCES "public"."wallet_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_tokens_request_idx" ON "access_tokens" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_idx" ON "audit_events" USING btree ("org_id","seq");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "deliveries_request_idx" ON "deliveries" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reference_values_category_idx" ON "reference_values" USING btree ("category");--> statement-breakpoint
CREATE INDEX "request_fields_request_idx" ON "request_fields" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "requests_org_idx" ON "requests" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_roles_unique_idx" ON "saved_roles" USING btree ("candidate_account_id","request_id");--> statement-breakpoint
CREATE INDEX "sms_events_org_idx" ON "sms_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_shares_unique_idx" ON "submission_shares" USING btree ("submission_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_values_unique_idx" ON "submission_values" USING btree ("submission_id","field_id");--> statement-breakpoint
CREATE INDEX "submissions_request_idx" ON "submissions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_items_owner_type_idx" ON "wallet_items" USING btree ("candidate_account_id","type");--> statement-breakpoint
CREATE INDEX "wallet_shares_owner_idx" ON "wallet_shares" USING btree ("candidate_account_id");