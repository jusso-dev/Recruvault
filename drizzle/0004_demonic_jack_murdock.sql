CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "discovery_profiles" (
	"candidate_account_id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"discoverable" boolean DEFAULT false NOT NULL,
	"clearance_level" text,
	"citizenship" text,
	"right_to_work" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_profiles_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD CONSTRAINT "discovery_profiles_candidate_account_id_candidate_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."candidate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_draft_unique_idx" ON "submissions" USING btree ("access_token_id") WHERE "submissions"."status" = 'started';