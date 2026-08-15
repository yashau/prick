CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`request_id` text,
	`actor_kind` text NOT NULL,
	`actor_subject` text NOT NULL,
	`identity_id` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`project_id` text,
	`environment_id` text,
	`target_key` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_env_ts_idx` ON `audit_log` (`environment_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_ts_idx` ON `audit_log` (`actor_subject`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_request_idx` ON `audit_log` (`request_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`rev` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_slug_uniq` ON `environments` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`role` text NOT NULL,
	`scope_type` text NOT NULL,
	`project_id` text,
	`environment_id` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_global_uniq` ON `grants` (`identity_id`) WHERE scope_type = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `grants_project_uniq` ON `grants` (`identity_id`,`project_id`) WHERE scope_type = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX `grants_environment_uniq` ON `grants` (`identity_id`,`environment_id`) WHERE scope_type = 'environment';--> statement-breakpoint
CREATE INDEX `grants_identity_idx` ON `grants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `grants_scope_role_idx` ON `grants` (`scope_type`,`role`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`display_name` text,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_kind_subject_uniq` ON `identities` (`kind`,`subject`);--> statement-breakpoint
CREATE TABLE `keyring_state` (
	`kid` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_rekey_at` integer,
	`rows_remaining` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uniq` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `secret_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text,
	`kid` text,
	`op` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_versions_env_key_version_uniq` ON `secret_versions` (`environment_id`,`key`,`version`);--> statement-breakpoint
CREATE INDEX `secret_versions_env_key_idx` ON `secret_versions` (`environment_id`,`key`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`key` text NOT NULL,
	`current_version` integer NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_env_key_uniq` ON `secrets` (`environment_id`,`key`);