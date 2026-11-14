ALTER TABLE "sessions" ALTER COLUMN "csrf_token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "credential_epoch" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "workspaces_owner_user_id_idx" ON "workspaces" USING btree ("owner_user_id");