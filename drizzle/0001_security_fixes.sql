ALTER TABLE "access_tokens" ADD COLUMN "otp_resends" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "otp_window_start" timestamp;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "otp_last_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "hashed_at" text NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "nda_view_mode" "jd_view_mode" DEFAULT 'view_only' NOT NULL;