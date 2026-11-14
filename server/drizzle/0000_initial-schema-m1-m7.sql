CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"user_agent_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"session_hash" text NOT NULL,
	"device_label" text NOT NULL,
	"ip_hash" text NOT NULL,
	"user_agent_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "setting_revisions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" "bytea",
	"credential_epoch" bigint DEFAULT 0 NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_quota_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"tag_id" bigint,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"path" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mark_tags" (
	"mark_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "mark_tags_mark_id_tag_id_pk" PRIMARY KEY("mark_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "marks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"tag_id" bigint NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"url" text,
	"desc" text,
	"deleted_at" timestamp with time zone,
	"source_id" text,
	"tag_updated_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marks_type_check" CHECK ("marks"."type" IN ('scan', 'text', 'image', 'link', 'file', 'recording', 'todo'))
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"tag_id" bigint NOT NULL,
	"content" text,
	"locale" text NOT NULL,
	"count" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_pin" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"conversation_id" bigint NOT NULL,
	"tag_id" bigint,
	"content" text,
	"role" text NOT NULL,
	"type" text NOT NULL,
	"image" text,
	"images" jsonb,
	"image_analyses" jsonb,
	"attachments" jsonb,
	"inserted" boolean DEFAULT false NOT NULL,
	"rag_sources" jsonb,
	"rag_source_details" jsonb,
	"agent_history" jsonb,
	"thinking" text,
	"quote_data" jsonb,
	"condensed_content" text,
	"condensed_at" timestamp with time zone,
	"original_token_count" integer,
	"original_message_count" integer,
	"ui_blocks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_compactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_compactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"conversation_id" bigint NOT NULL,
	"summary" text NOT NULL,
	"covered_through_chat_id" bigint NOT NULL,
	"tail_start_chat_id" bigint,
	"source_token_count" integer NOT NULL,
	"summary_token_count" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"revision" integer NOT NULL,
	"retained_turn_count" integer DEFAULT 0 NOT NULL,
	"pruned_tool_result_count" integer DEFAULT 0 NOT NULL,
	"pruned_tool_token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"canvas_type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"thumbnail_path" text,
	"pinned_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"event_type" text NOT NULL,
	"path" text NOT NULL,
	"previous_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_events_event_type_check" CHECK ("file_events"."event_type" IN ('created', 'changed', 'deleted', 'moved'))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"mime_type" text,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "image_analysis_cache" (
	"workspace_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"image_hash" text NOT NULL,
	"query_hash" text NOT NULL,
	"ocr_text" text,
	"visual_analysis" text,
	"mime_type" text,
	"width" integer,
	"height" integer,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_analysis_cache_workspace_id_cache_key_pk" PRIMARY KEY("workspace_id","cache_key")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"workspace_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"indexed_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_workspace_id_source_key_pk" PRIMARY KEY("workspace_id","source_key"),
	CONSTRAINT "knowledge_sources_source_type_check" CHECK ("knowledge_sources"."source_type" IN ('article', 'record', 'canvas')),
	CONSTRAINT "knowledge_sources_status_check" CHECK ("knowledge_sources"."status" IN ('pending', 'indexing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "vector_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vector_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_id" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" text NOT NULL,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_chunks_source_type_check" CHECK ("vector_chunks"."source_type" IN ('article', 'record', 'canvas'))
);
--> statement-breakpoint
CREATE TABLE "wiki_jobs" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"id" text NOT NULL,
	"status" text NOT NULL,
	"ready_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	CONSTRAINT "wiki_jobs_workspace_id_context_id_id_pk" PRIMARY KEY("workspace_id","context_id","id")
);
--> statement-breakpoint
CREATE TABLE "wiki_meta" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "wiki_meta_workspace_id_context_id_key_pk" PRIMARY KEY("workspace_id","context_id","key")
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "wiki_pages_workspace_id_context_id_id_pk" PRIMARY KEY("workspace_id","context_id","id")
);
--> statement-breakpoint
CREATE TABLE "wiki_revisions" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"id" text NOT NULL,
	"source_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "wiki_revisions_workspace_id_context_id_id_pk" PRIMARY KEY("workspace_id","context_id","id")
);
--> statement-breakpoint
CREATE TABLE "wiki_segments" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"cache_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "wiki_segments_workspace_id_context_id_cache_key_pk" PRIMARY KEY("workspace_id","context_id","cache_key")
);
--> statement-breakpoint
CREATE TABLE "wiki_sources" (
	"workspace_id" uuid NOT NULL,
	"context_id" text NOT NULL,
	"stable_id" text NOT NULL,
	"source_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"revision_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "wiki_sources_workspace_id_context_id_stable_id_pk" PRIMARY KEY("workspace_id","context_id","stable_id")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" text,
	"category" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_id" text,
	"apply_mode" text DEFAULT 'relevant' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"conflict_key" text,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"indexing_status" text DEFAULT 'pending' NOT NULL,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"last_recall_reason" text,
	"replaced_id" text,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_category_check" CHECK ("memories"."category" IN ('preference', 'memory'))
);
--> statement-breakpoint
CREATE TABLE "memory_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memory_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"conversation_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_policies" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"use_memories" boolean DEFAULT true NOT NULL,
	"generate_memories" boolean DEFAULT true NOT NULL,
	"exclude_external_context" boolean DEFAULT true NOT NULL,
	"generation_started_at" timestamp with time zone,
	"defaults_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_revisions" ADD CONSTRAINT "setting_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_tags" ADD CONSTRAINT "mark_tags_mark_id_marks_id_fk" FOREIGN KEY ("mark_id") REFERENCES "public"."marks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_tags" ADD CONSTRAINT "mark_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark_tags" ADD CONSTRAINT "mark_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_events" ADD CONSTRAINT "file_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_events" ADD CONSTRAINT "file_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_analysis_cache" ADD CONSTRAINT "image_analysis_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_chunks" ADD CONSTRAINT "vector_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_jobs" ADD CONSTRAINT "wiki_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_meta" ADD CONSTRAINT "wiki_meta_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_segments" ADD CONSTRAINT "wiki_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_policies" ADD CONSTRAINT "memory_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_created_idx" ON "audit_events" USING btree ("actor_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_user_scope_key" ON "idempotency_keys" USING btree ("user_id","scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_user_kind_ref_key" ON "secrets" USING btree ("user_id","kind","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_session_hash_key" ON "sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_lower_key" ON "users" USING btree (lower("login"));--> statement-breakpoint
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_workspace_dedupe_key" ON "activity_events" USING btree ("workspace_id","dedupe_key") WHERE "activity_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "activity_events_workspace_created_idx" ON "activity_events" USING btree ("workspace_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "mark_tags_workspace_tag_idx" ON "mark_tags" USING btree ("workspace_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marks_workspace_source_key" ON "marks" USING btree ("workspace_id","source_id") WHERE "marks"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "marks_workspace_tag_created_idx" ON "marks" USING btree ("workspace_id","tag_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "marks_workspace_source_idx" ON "marks" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_tag_idx" ON "notes" USING btree ("workspace_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_workspace_name_key" ON "tags" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "tags_workspace_idx" ON "tags" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chat_messages_workspace_conversation_idx" ON "chat_messages" USING btree ("workspace_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "chat_messages_workspace_tag_idx" ON "chat_messages" USING btree ("workspace_id","tag_id","id");--> statement-breakpoint
CREATE INDEX "conversation_compactions_workspace_idx" ON "conversation_compactions" USING btree ("workspace_id","conversation_id","revision" desc);--> statement-breakpoint
CREATE INDEX "conversations_workspace_updated_idx" ON "conversations" USING btree ("workspace_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "canvases_workspace_idx" ON "canvases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "file_events_workspace_idx" ON "file_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_workspace_path_active_key" ON "files" USING btree ("workspace_id","path") WHERE "files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "files_workspace_path_idx" ON "files" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "image_analysis_cache_workspace_hash_idx" ON "image_analysis_cache" USING btree ("workspace_id","image_hash","updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_workspace_type_id_key" ON "knowledge_sources" USING btree ("workspace_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_workspace_type_status_idx" ON "knowledge_sources" USING btree ("workspace_id","source_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_chunks_workspace_source_chunk_key" ON "vector_chunks" USING btree ("workspace_id","source_type","source_id","chunk_id");--> statement-breakpoint
CREATE INDEX "vector_chunks_workspace_source_idx" ON "vector_chunks" USING btree ("workspace_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "wiki_revisions_workspace_hashes_idx" ON "wiki_revisions" USING btree ("workspace_id","context_id","input_hash","output_hash");--> statement-breakpoint
CREATE INDEX "memories_workspace_category_idx" ON "memories" USING btree ("workspace_id","category");--> statement-breakpoint
CREATE INDEX "memories_workspace_access_idx" ON "memories" USING btree ("workspace_id","access_count");--> statement-breakpoint
CREATE INDEX "memories_workspace_scope_idx" ON "memories" USING btree ("workspace_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "memories_workspace_conflict_idx" ON "memories" USING btree ("workspace_id","conflict_key");--> statement-breakpoint
CREATE INDEX "memories_workspace_updated_idx" ON "memories" USING btree ("workspace_id","updated_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_jobs_workspace_conversation_revision_key" ON "memory_jobs" USING btree ("workspace_id","conversation_id","revision");--> statement-breakpoint
CREATE INDEX "memory_jobs_workspace_status_idx" ON "memory_jobs" USING btree ("workspace_id","status","updated_at");