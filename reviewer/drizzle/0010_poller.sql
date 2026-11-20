CREATE TABLE "github_answers" (
	"question" text PRIMARY KEY NOT NULL,
	"etag" text,
	"answer" jsonb NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poller_events" (
	"project" text NOT NULL,
	"event" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone,
	"run_id" text,
	"handled_at" timestamp with time zone,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poller_events_project_event_pk" PRIMARY KEY("project","event")
);
--> statement-breakpoint
CREATE TABLE "poller_projects" (
	"project" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_to" timestamp with time zone NOT NULL,
	"pulls_etag" text,
	"last_pass_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poller_events" ADD CONSTRAINT "poller_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;