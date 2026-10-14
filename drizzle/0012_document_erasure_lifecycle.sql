ALTER TABLE "deletion_tasks" ADD COLUMN "erasure_id" uuid;--> statement-breakpoint
ALTER TABLE "document_migrations" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_migrations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "erasure_records" ADD COLUMN "objects_queued" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_tasks" ADD CONSTRAINT "deletion_tasks_erasure_id_erasure_records_id_fk" FOREIGN KEY ("erasure_id") REFERENCES "public"."erasure_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_tasks_erasure_idx" ON "deletion_tasks" USING btree ("erasure_id");--> statement-breakpoint
DELETE FROM "erasure_records" a USING "erasure_records" b WHERE a."subject_type" = b."subject_type" AND a."subject_id" = b."subject_id" AND (a."created_at", a."id") > (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_records_subject_idx" ON "erasure_records" USING btree ("subject_type","subject_id");