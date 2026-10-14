CREATE TABLE "deletion_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"owner_scope" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "document_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"document_id" uuid NOT NULL,
	"old_storage_key" text NOT NULL,
	"new_storage_key" text NOT NULL,
	"dek_id" uuid,
	"state" text DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"access_revoked_at" timestamp,
	"keys_shredded_at" timestamp,
	"cleanup_pending_at" timestamp,
	"cleanup_finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"owner_scope" text,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_bootstrap" (
	"id" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
	"token_hash" text NOT NULL,
	"consumed_at" timestamp,
	"consumed_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "vault_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"verifier" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key_wrapped" text,
	"kdf" text,
	"kdf_salt" text,
	"kdf_params" jsonb,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "vault_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"rotated_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "vault_unlocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vault_key_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"wrapped_crk" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb DEFAULT '["legacy:full"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "vault_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "wrapped_vault_key" text;--> statement-breakpoint
ALTER TABLE "candidate_api_keys" ADD COLUMN "scopes" jsonb DEFAULT '["legacy:full"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_api_keys" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "candidate_api_keys" ADD COLUMN "vault_key_id" uuid;--> statement-breakpoint
ALTER TABLE "candidate_api_keys" ADD COLUMN "wrapped_vault_key" text;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "wrap_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "owner_type" text;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "aad" text;--> statement-breakpoint
ALTER TABLE "data_keys" ADD COLUMN "render_wrapped" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "original_content_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "dek_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "envelope_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "erased_at" timestamp;--> statement-breakpoint
ALTER TABLE "wallet_documents" ADD COLUMN "original_content_type" text;--> statement-breakpoint
ALTER TABLE "wallet_documents" ADD COLUMN "dek_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_documents" ADD COLUMN "envelope_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_migrations" ADD CONSTRAINT "document_migrations_dek_id_data_keys_id_fk" FOREIGN KEY ("dek_id") REFERENCES "public"."data_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_unlocks" ADD CONSTRAINT "vault_unlocks_vault_key_id_vault_keys_id_fk" FOREIGN KEY ("vault_key_id") REFERENCES "public"."vault_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_unlocks" ADD CONSTRAINT "vault_unlocks_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_tasks_state_idx" ON "deletion_tasks" USING btree ("state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_migrations_document_idx" ON "document_migrations" USING btree ("table_name","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_dedupe_idx" ON "outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_events_state_idx" ON "outbox_events" USING btree ("state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_keys_owner_version_idx" ON "vault_keys" USING btree ("owner_type","owner_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_keys_one_active_idx" ON "vault_keys" USING btree ("owner_type","owner_id") WHERE "vault_keys"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vault_keys_owner_idx" ON "vault_keys" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_unlocks_session_key_idx" ON "vault_unlocks" USING btree ("session_id","vault_key_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_dek_id_data_keys_id_fk" FOREIGN KEY ("dek_id") REFERENCES "public"."data_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_documents" ADD CONSTRAINT "wallet_documents_dek_id_data_keys_id_fk" FOREIGN KEY ("dek_id") REFERENCES "public"."data_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "api_keys" SET "expires_at" = now() + interval '90 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
UPDATE "candidate_api_keys" SET "expires_at" = now() + interval '90 days' WHERE "expires_at" IS NULL;