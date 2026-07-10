ALTER TABLE "recruiter_match_settings" DROP CONSTRAINT "recruiter_match_settings_updated_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "recruiter_match_settings" ADD CONSTRAINT "recruiter_match_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;