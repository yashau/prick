-- Groups.
--
-- REVIEWED BEFORE COMMIT, per drizzle.config.ts. Two things were checked and
-- one was changed:
--
--   1. NO `PRAGMA foreign_keys=OFF`. drizzle-kit emits that around a table
--      REBUILD, and D1 rejects a pragma change mid-transaction. There is no
--      rebuild here because this migration only CREATEs -- no existing column
--      changes type or nullability, and `grants` is not touched at all. Nothing
--      needed rewriting to `defer_foreign_keys`.
--   2. STATEMENT ORDER was changed from the generator's alphabetical output
--      (group_grants, group_members, groups) to parent-first. SQLite tolerates a
--      forward foreign-key reference at CREATE time, so the generated order
--      would have worked, but "the child table is created before its parent"
--      is not a thing a reviewer should have to verify is safe.
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_uniq` ON `groups` (`slug`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`added_at` integer NOT NULL,
	`added_by` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_group_identity_uniq` ON `group_members` (`group_id`,`identity_id`);--> statement-breakpoint
CREATE INDEX `group_members_identity_idx` ON `group_members` (`identity_id`);--> statement-breakpoint
CREATE TABLE `group_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`role` text NOT NULL,
	`scope_type` text NOT NULL,
	`project_id` text,
	`environment_id` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_grants_global_uniq` ON `group_grants` (`group_id`) WHERE scope_type = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `group_grants_project_uniq` ON `group_grants` (`group_id`,`project_id`) WHERE scope_type = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX `group_grants_environment_uniq` ON `group_grants` (`group_id`,`environment_id`) WHERE scope_type = 'environment';--> statement-breakpoint
CREATE INDEX `group_grants_group_idx` ON `group_grants` (`group_id`);--> statement-breakpoint
CREATE INDEX `group_grants_scope_role_idx` ON `group_grants` (`scope_type`,`role`);
