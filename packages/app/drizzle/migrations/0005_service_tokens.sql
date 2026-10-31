CREATE TABLE `service_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`cloudflare_id` text NOT NULL,
	`client_id` text NOT NULL,
	`cloudflare_name` text NOT NULL,
	`adopted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`rotated_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_tokens_cloudflare_id_uniq` ON `service_tokens` (`cloudflare_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_tokens_identity_uniq` ON `service_tokens` (`identity_id`);