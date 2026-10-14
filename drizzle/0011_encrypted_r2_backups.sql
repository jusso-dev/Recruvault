CREATE TABLE "backup_config" (
	"id" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"hour_utc" integer DEFAULT 16 NOT NULL,
	"retain_count" integer DEFAULT 14 NOT NULL,
	"r2_account_id" text NOT NULL,
	"r2_bucket" text NOT NULL,
	"r2_access_key_id" text NOT NULL,
	"r2_secret_wrapped" text NOT NULL,
	"backup_key_wrapped" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"object_key" text,
	"size_bytes" integer,
	"checksum" text,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_dedupe_idx" ON "backup_runs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at");