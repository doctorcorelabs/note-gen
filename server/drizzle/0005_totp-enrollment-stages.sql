CREATE TABLE "totp_enrollment_stages" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_sealed" text NOT NULL,
	"key_version" integer NOT NULL,
	"staged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "totp_enrollment_stages" ADD CONSTRAINT "totp_enrollment_stages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;