CREATE TABLE "search_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text,
	"authors" text,
	"journal" text,
	"year" integer,
	"doi" text,
	"pmid" text,
	"pmcid" text,
	"url" text,
	"oa_flag" boolean,
	"snippet" text,
	"disposition" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"record_mark_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_candidates_source_kind_check" CHECK ("search_candidates"."source_kind" IN ('pubmed', 'europepmc', 'exa')),
	CONSTRAINT "search_candidates_disposition_check" CHECK ("search_candidates"."disposition" IN ('pending', 'accepted', 'duplicate', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "search_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"candidate_id" uuid,
	"fact_candidate_id" uuid,
	"query_text" text NOT NULL,
	"source_kind" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"note" text,
	CONSTRAINT "search_evidence_source_kind_check" CHECK ("search_evidence"."source_kind" IN ('pubmed', 'europepmc', 'exa'))
);
--> statement-breakpoint
CREATE TABLE "search_fact_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"text" text NOT NULL,
	"score" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"fact_id" uuid,
	"assessor_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_fact_candidates_score_check" CHECK ("search_fact_candidates"."score" IS NULL OR ("search_fact_candidates"."score" >= 0 AND "search_fact_candidates"."score" <= 100)),
	CONSTRAINT "search_fact_candidates_status_check" CHECK ("search_fact_candidates"."status" IN ('pending', 'mapped', 'unmapped'))
);
--> statement-breakpoint
CREATE TABLE "search_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "search_job_steps_step_check" CHECK ("search_job_steps"."step" IN ('collector_pubmed', 'collector_exa', 'assessor', 'complement')),
	CONSTRAINT "search_job_steps_status_check" CHECK ("search_job_steps"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "search_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"topic" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"budget_exa_usd" numeric,
	"cost_exa_usd" numeric DEFAULT '0' NOT NULL,
	"created_by_user_id" uuid,
	"created_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	CONSTRAINT "search_jobs_status_check" CHECK ("search_jobs"."status" IN ('queued', 'collecting', 'assessing', 'complementing', 'writing', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "search_candidates" ADD CONSTRAINT "search_candidates_job_id_search_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD CONSTRAINT "search_candidates_record_mark_id_marks_id_fk" FOREIGN KEY ("record_mark_id") REFERENCES "public"."marks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_evidence" ADD CONSTRAINT "search_evidence_job_id_search_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_evidence" ADD CONSTRAINT "search_evidence_candidate_id_search_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."search_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_evidence" ADD CONSTRAINT "search_evidence_fact_candidate_id_search_fact_candidates_id_fk" FOREIGN KEY ("fact_candidate_id") REFERENCES "public"."search_fact_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_fact_candidates" ADD CONSTRAINT "search_fact_candidates_job_id_search_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_fact_candidates" ADD CONSTRAINT "search_fact_candidates_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_job_steps" ADD CONSTRAINT "search_job_steps_job_id_search_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."search_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_created_by_token_id_agent_tokens_id_fk" FOREIGN KEY ("created_by_token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_candidates_job_external_key" ON "search_candidates" USING btree ("job_id","external_id");--> statement-breakpoint
CREATE INDEX "search_candidates_job_idx" ON "search_candidates" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "search_evidence_job_idx" ON "search_evidence" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "search_fact_candidates_job_idx" ON "search_fact_candidates" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_job_steps_job_step_key" ON "search_job_steps" USING btree ("job_id","step");--> statement-breakpoint
CREATE INDEX "search_jobs_workspace_project_created_idx" ON "search_jobs" USING btree ("workspace_id","project_key","created_at");--> statement-breakpoint
CREATE INDEX "search_jobs_status_created_idx" ON "search_jobs" USING btree ("status","created_at");