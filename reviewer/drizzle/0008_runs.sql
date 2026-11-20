CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project" text,
	"parent_id" text,
	"state" text DEFAULT 'running' NOT NULL,
	"stage" text,
	"error_type" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_id_runs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;