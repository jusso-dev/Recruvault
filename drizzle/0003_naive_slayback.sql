CREATE INDEX "submission_documents_submission_idx" ON "submission_documents" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submissions_candidate_idx" ON "submissions" USING btree ("candidate_account_id");--> statement-breakpoint
CREATE INDEX "submissions_access_token_idx" ON "submissions" USING btree ("access_token_id");