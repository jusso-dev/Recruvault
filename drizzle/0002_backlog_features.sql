CREATE TABLE "audit_chain_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_scope" text NOT NULL,
	"verified_through_seq" integer NOT NULL,
	"hash" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_checkpoints_chain_scope_unique" UNIQUE("chain_scope")
);
--> statement-breakpoint
CREATE TABLE "link_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "reminder_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "resend_domain_id" text;--> statement-breakpoint
CREATE INDEX "access_tokens_expires_idx" ON "access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "deliveries_access_token_idx" ON "deliveries" USING btree ("access_token_id");