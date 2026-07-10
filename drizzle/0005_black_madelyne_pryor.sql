ALTER TYPE "public"."submission_status" ADD VALUE 'shortlisted' BEFORE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'interview' BEFORE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'offer' BEFORE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'placed' BEFORE 'follow_up';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'declined';--> statement-breakpoint
ALTER TYPE "public"."submission_status" ADD VALUE 'withdrawn';