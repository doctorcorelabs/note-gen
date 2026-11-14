ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "audit_events_actor_created_idx";--> statement-breakpoint
DROP INDEX "users_login_lower_key";--> statement-breakpoint
DROP INDEX "workspaces_owner_id_idx";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "actor_id";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "action";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "target_type";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "target_id";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "ip_hash";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "ip_hash";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "user_agent_hash";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "idle_expires_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "login";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_admin";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "suspended_at";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "owner_id";