CREATE TABLE "test_databases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
