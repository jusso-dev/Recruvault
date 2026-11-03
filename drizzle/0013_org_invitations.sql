CREATE TABLE "org_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_by" text,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_invitations_org_idx" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_open_idx" ON "org_invitations" USING btree ("org_id","email") WHERE "org_invitations"."accepted_at" is null and "org_invitations"."revoked_at" is null;