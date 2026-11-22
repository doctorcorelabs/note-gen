CREATE TABLE "references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"number" integer,
	"source_record_id" bigint,
	"title" text,
	"authors" text,
	"journal" text,
	"year" integer,
	"doi" text,
	"pmid" text,
	"pmcid" text,
	"url" text,
	"oa_flag" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_references" (
	"fact_id" uuid NOT NULL,
	"reference_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "fact_references_fact_id_reference_id_pk" PRIMARY KEY("fact_id","reference_id")
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"text" text NOT NULL,
	"score" integer NOT NULL,
	"status" text DEFAULT 'unmapped' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_score_check" CHECK ("facts"."score" >= 0 AND "facts"."score" <= 100),
	CONSTRAINT "facts_status_check" CHECK ("facts"."status" IN ('mapped', 'unmapped'))
);
--> statement-breakpoint
CREATE TABLE "mark_bibliography" (
	"mark_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text,
	"authors" text,
	"journal" text,
	"year" integer,
	"doi" text,
	"pmid" text,
	"pmcid" text,
	"url" text,
	"oa_flag" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_source_record_id_marks_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."marks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_references" ADD CONSTRAINT "fact_references_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_references" ADD CONSTRAINT "fact_references_reference_id_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_references" ADD CONSTRAINT "fact_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_bibliography" ADD CONSTRAINT "mark_bibliography_mark_id_marks_id_fk" FOREIGN KEY ("mark_id") REFERENCES "public"."marks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_bibliography" ADD CONSTRAINT "mark_bibliography_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "references_workspace_project_number_key" ON "references" USING btree ("workspace_id","project_key","number");--> statement-breakpoint
CREATE UNIQUE INDEX "references_workspace_doi_key" ON "references" USING btree ("workspace_id","doi") WHERE "references"."doi" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "references_workspace_pmid_key" ON "references" USING btree ("workspace_id","pmid") WHERE "references"."pmid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "references_workspace_project_idx" ON "references" USING btree ("workspace_id","project_key");--> statement-breakpoint
CREATE INDEX "fact_references_workspace_reference_idx" ON "fact_references" USING btree ("workspace_id","reference_id");--> statement-breakpoint
CREATE INDEX "facts_workspace_project_idx" ON "facts" USING btree ("workspace_id","project_key");--> statement-breakpoint
CREATE INDEX "mark_bibliography_workspace_doi_idx" ON "mark_bibliography" USING btree ("workspace_id","doi");--> statement-breakpoint
CREATE INDEX "mark_bibliography_workspace_pmid_idx" ON "mark_bibliography" USING btree ("workspace_id","pmid");