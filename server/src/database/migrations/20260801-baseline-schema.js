'use strict';

/**
 * Baseline schema migration — squashes what previously only existed via
 * sequelize.sync() (development-only) into an actual migration, so a
 * genuinely fresh database (e.g. new Railway MySQL) can be bootstrapped
 * via `db:migrate` alone. Was deferred as F-10 in
 * docs/audit-remediation-plan.md; resolved here.
 *
 * The DDL below was captured verbatim from Sequelize's own sync() output
 * against an empty database with the current models — not hand-authored.
 * It represents today's FINAL schema (already includes every column/table
 * every later incremental migration below would otherwise add), so this
 * must run BEFORE all of them (hence the 20260801 date, earliest in the
 * migrations directory) and must mark them as already-satisfied once done
 * — otherwise a migration like 20260802's `addColumn('tasks', 'points')`
 * would fail with "duplicate column" against a table this migration
 * already created with `points` present.
 *
 * Existing dev/staging databases (which already have this schema via
 * sync()) must have this migration recorded in sequelize_meta WITHOUT
 * running it — see the deployment plan for the exact `INSERT` used.
 */

const BASELINE_DDL = [
      "CREATE TABLE IF NOT EXISTS `users` (`id` CHAR(36) BINARY , `email` VARCHAR(255) NOT NULL UNIQUE, `password_hash` VARCHAR(255) NOT NULL, `display_name` VARCHAR(100) NOT NULL, `avatar_url` VARCHAR(500), `avatar_emoji` VARCHAR(10), `avatar_preset_id` VARCHAR(50), `date_of_birth` DATE, `home_address` VARCHAR(500), `phone` VARCHAR(32) UNIQUE, `is_phone_verified` TINYINT(1) DEFAULT false, `add_to_calendar` TINYINT(1) DEFAULT true, `notify_household` TINYINT(1) DEFAULT true, `role` ENUM('admin', 'member', 'child') DEFAULT 'member', `is_verified` TINYINT(1) DEFAULT false, `google_id` VARCHAR(255) UNIQUE, `apple_id` VARCHAR(255) UNIQUE, `last_login_at` DATETIME, `scheduled_deletion_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`)) ENGINE=InnoDB;",
      "ALTER TABLE `users` ADD INDEX `users_email` (`email`)",
      "ALTER TABLE `users` ADD INDEX `users_phone` (`phone`)",
      "CREATE TABLE IF NOT EXISTS `refresh_tokens` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `token` VARCHAR(500) NOT NULL, `expires_at` DATETIME NOT NULL, `revoked_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `refresh_tokens` ADD INDEX `refresh_tokens_token` (`token`)",
      "ALTER TABLE `refresh_tokens` ADD INDEX `idx_refresh_user_created` (`user_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `email_verifications` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `token` VARCHAR(255) NOT NULL, `expires_at` DATETIME NOT NULL, `verified_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `email_verifications` ADD INDEX `idx_email_verification_user_token` (`user_id`, `token`)",
      "CREATE TABLE IF NOT EXISTS `password_resets` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `token` VARCHAR(255) NOT NULL, `expires_at` DATETIME NOT NULL, `used_at` DATETIME, `attempts` INTEGER NOT NULL DEFAULT 0, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `password_resets` ADD INDEX `password_resets_token` (`token`)",
      "ALTER TABLE `password_resets` ADD INDEX `idx_password_reset_user_created` (`user_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `households` (`id` CHAR(36) BINARY , `name` VARCHAR(100) NOT NULL, `invite_code` VARCHAR(20) NOT NULL UNIQUE, `storage_used_bytes` BIGINT DEFAULT 0, `storage_limit_bytes` BIGINT DEFAULT 2147483648, `cover_photo_url` VARCHAR(255), `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC', `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, `scheduled_deletion_at` DATETIME, PRIMARY KEY (`id`)) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `household_members` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `role` ENUM('admin', 'member', 'child') NOT NULL, `joined_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, UNIQUE `household_members_household_id_user_id_unique` (`household_id`, `user_id`), PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `household_members` ADD UNIQUE INDEX `household_members_household_id_user_id` (`household_id`, `user_id`)",
      "CREATE TABLE IF NOT EXISTS `household_action_requests` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `requested_by` CHAR(36) BINARY, `type` ENUM('leave', 'delete') NOT NULL, `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `reviewer_note` VARCHAR(500), `reviewed_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `invitations` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `invited_by` CHAR(36) BINARY, `code` VARCHAR(20) NOT NULL UNIQUE, `email` VARCHAR(255), `expires_at` DATETIME NOT NULL, `accepted_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `feed_posts` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `content` TEXT, `media_type` ENUM('text', 'photo', 'video') NOT NULL, `activity` VARCHAR(100), `location` VARCHAR(200), `privacy` ENUM('household', 'members') DEFAULT 'household', `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `feed_posts` ADD INDEX `idx_feed_posts_household_created` (`household_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `feed_likes` (`id` CHAR(36) BINARY , `post_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`post_id`) REFERENCES `feed_posts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `feed_likes` ADD UNIQUE INDEX `feed_likes_post_id_user_id` (`post_id`, `user_id`)",
      "CREATE TABLE IF NOT EXISTS `feed_comments` (`id` CHAR(36) BINARY , `post_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `parent_id` CHAR(36) BINARY, `content` TEXT NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`post_id`) REFERENCES `feed_posts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`parent_id`) REFERENCES `feed_comments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `feed_comments` ADD INDEX `feed_comments_post_id` (`post_id`)",
      "ALTER TABLE `feed_comments` ADD INDEX `feed_comments_parent_id` (`parent_id`)",
      "CREATE TABLE IF NOT EXISTS `comment_reactions` (`id` CHAR(36) BINARY , `comment_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `reaction` VARCHAR(50) NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`comment_id`) REFERENCES `feed_comments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `comment_reactions` ADD UNIQUE INDEX `comment_reactions_comment_id_user_id_reaction` (`comment_id`, `user_id`, `reaction`)",
      "CREATE TABLE IF NOT EXISTS `feed_media` (`id` CHAR(36) BINARY , `post_id` CHAR(36) BINARY, `media_url` VARCHAR(500) NOT NULL, `media_type` ENUM('photo', 'video') NOT NULL, `thumbnail_url` VARCHAR(500), `file_size_bytes` INTEGER, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`post_id`) REFERENCES `feed_posts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `tasks` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `created_by` CHAR(36) BINARY, `title` VARCHAR(200) NOT NULL, `description` TEXT, `due_date` DATE, `recurrence` ENUM('none', 'daily', 'weekly', 'biweekly', 'monthly') DEFAULT 'none', `recurrence_end_date` DATE, `points` INTEGER NOT NULL DEFAULT 5, `points_reduced` TINYINT(1) NOT NULL DEFAULT false, `status` ENUM('pending', 'completed', 'reopened') DEFAULT 'pending', `completed_at` DATETIME, `completed_by` CHAR(36) BINARY, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`completed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `tasks` ADD INDEX `idx_tasks_household_status` (`household_id`, `status`)",
      "CREATE TABLE IF NOT EXISTS `task_assignees` (`id` CHAR(36) BINARY , `task_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, UNIQUE `task_assignees_user_id_task_id_unique` (`task_id`, `user_id`), PRIMARY KEY (`id`), FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `grocery_items` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `name` VARCHAR(200) NOT NULL, `quantity` VARCHAR(50), `note` TEXT, `assigned_to` CHAR(36) BINARY, `is_bought` TINYINT(1) DEFAULT false, `bought_by` CHAR(36) BINARY, `bought_at` DATETIME, `archived_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`bought_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `grocery_items` ADD INDEX `idx_grocery_household_bought` (`household_id`, `is_bought`)",
      "CREATE TABLE IF NOT EXISTS `todo_items` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `title` VARCHAR(200) NOT NULL, `due_date` DATE, `assigned_to` CHAR(36) BINARY, `is_completed` TINYINT(1) DEFAULT false, `completed_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `expenses` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `paid_by` CHAR(36) BINARY, `title` VARCHAR(200) NOT NULL, `amount` DECIMAL(10,2) NOT NULL, `split_type` ENUM('equal', 'custom') DEFAULT 'equal', `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`paid_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `expenses` ADD INDEX `idx_expenses_household_created` (`household_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `expense_participants` (`id` CHAR(36) BINARY , `expense_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `share_amount` DECIMAL(10,2) NOT NULL, `is_settled` TINYINT(1) DEFAULT false, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`expense_id`) REFERENCES `expenses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `settlements` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `from_user_id` CHAR(36) BINARY, `to_user_id` CHAR(36) BINARY, `amount` DECIMAL(10,2) NOT NULL, `settled_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`from_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`to_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `vault_documents` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `uploaded_by` CHAR(36) BINARY, `name` VARCHAR(255) NOT NULL, `mime_type` VARCHAR(100) NOT NULL, `size_bytes` INTEGER NOT NULL, `encrypted_key` TEXT NOT NULL, `iv` VARCHAR(64) NOT NULL, `s3_key` VARCHAR(500) NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `vault_keys` (`user_id` CHAR(36) BINARY, `household_id` CHAR(36) BINARY, `public_key` TEXT NOT NULL, `private_key_encrypted` TEXT NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `vault_document_keys` (`document_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `wrapped_key` TEXT NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, FOREIGN KEY (`document_id`) REFERENCES `vault_documents` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `conversations` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `type` ENUM('dm', 'group', 'household') NOT NULL, `name` VARCHAR(100), `created_by` CHAR(36) BINARY, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `conversations` ADD INDEX `conversations_household_id` (`household_id`)",
      "CREATE TABLE IF NOT EXISTS `chat_messages` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `conversation_id` CHAR(36) BINARY, `sender_id` CHAR(36) BINARY, `content` TEXT, `media_url` VARCHAR(500), `type` ENUM('text', 'image', 'voice') NOT NULL DEFAULT 'text', `duration_seconds` INTEGER, `reply_to_id` CHAR(36) BINARY, `edited_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`reply_to_id`) REFERENCES `chat_messages` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `chat_messages` ADD INDEX `idx_chat_messages_household_created` (`household_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `chat_reactions` (`id` CHAR(36) BINARY , `message_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `reaction` VARCHAR(50) NOT NULL, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`message_id`) REFERENCES `chat_messages` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `chat_reactions` ADD UNIQUE INDEX `chat_reactions_message_id_user_id_reaction` (`message_id`, `user_id`, `reaction`)",
      "CREATE TABLE IF NOT EXISTS `check_ins` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `latitude` DECIMAL(10,7), `longitude` DECIMAL(10,7), `address` VARCHAR(500), `note` TEXT, `checked_in_at` DATETIME NOT NULL, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `ping_requests` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `requester_id` CHAR(36) BINARY, `target_user_id` CHAR(36) BINARY, `status` ENUM('pending', 'fulfilled', 'declined', 'expired') NOT NULL DEFAULT 'pending', `note` VARCHAR(500), `check_in_id` CHAR(36) BINARY, `responded_at` DATETIME, `share_duration_minutes` INTEGER, `share_expires_at` DATETIME, `live_latitude` DECIMAL(10,7), `live_longitude` DECIMAL(10,7), `live_updated_at` DATETIME, `created_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`requester_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`target_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`check_in_id`) REFERENCES `check_ins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `saved_places` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `name` VARCHAR(100) NOT NULL, `icon` ENUM('home', 'office', 'school', 'custom') NOT NULL DEFAULT 'custom', `latitude` DECIMAL(10,7) NOT NULL, `longitude` DECIMAL(10,7) NOT NULL, `address` VARCHAR(500), `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `calendar_events` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `created_by` CHAR(36) BINARY, `title` VARCHAR(200) NOT NULL, `description` TEXT, `event_date` DATE NOT NULL, `start_time` TIME, `end_time` TIME, `is_recurring` TINYINT(1) DEFAULT false, `recurrence_rule` VARCHAR(100), `google_event_id` VARCHAR(255), `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `calendar_events` ADD INDEX `idx_calendar_household_date` (`household_id`, `event_date`)",
      "CREATE TABLE IF NOT EXISTS `calendar_sync_states` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `google_calendar_id` VARCHAR(255) NOT NULL, `sync_token` VARCHAR(255), `last_synced_at` DATETIME, `is_active` TINYINT(1) DEFAULT true, `access_token` TEXT, `refresh_token` TEXT, `token_expires_at` DATETIME, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `calendar_invitees` (`id` CHAR(36) BINARY , `calendar_event_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, UNIQUE `calendar_invitees_user_id_calendar_event_id_unique` (`calendar_event_id`, `user_id`), PRIMARY KEY (`id`), FOREIGN KEY (`calendar_event_id`) REFERENCES `calendar_events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `calendar_invitees` ADD INDEX `idx_calendar_invitee_event` (`calendar_event_id`)",
      "CREATE TABLE IF NOT EXISTS `notification_preferences` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `new_post` TINYINT(1) DEFAULT true, `task_assigned` TINYINT(1) DEFAULT true, `task_completed` TINYINT(1) DEFAULT true, `check_in` TINYINT(1) DEFAULT true, `ping_request` TINYINT(1) DEFAULT true, `new_expense` TINYINT(1) DEFAULT true, `chat_message` TINYINT(1) DEFAULT true, `calendar_event` TINYINT(1) DEFAULT true, `member_joined` TINYINT(1) DEFAULT true, `created_at` DATETIME, `updated_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "CREATE TABLE IF NOT EXISTS `notification_history` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY, `type` VARCHAR(50) NOT NULL, `title` VARCHAR(200) NOT NULL, `body` TEXT, `data` JSON, `is_read` TINYINT(1) DEFAULT false, `read_at` DATETIME, `created_at` DATETIME, `deleted_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `notification_history` ADD INDEX `idx_notifications_user_read` (`user_id`, `is_read`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `device_tokens` (`id` CHAR(36) BINARY , `user_id` CHAR(36) BINARY NOT NULL, `token` VARCHAR(500) NOT NULL, `platform` ENUM('ios', 'android', 'web') NOT NULL, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`)) ENGINE=InnoDB;",
      "ALTER TABLE `device_tokens` ADD INDEX `idx_device_tokens_user_id` (`user_id`)",
      "ALTER TABLE `device_tokens` ADD UNIQUE INDEX `idx_device_tokens_token` (`token`)",
      "CREATE TABLE IF NOT EXISTS `phone_verifications` (`id` CHAR(36) BINARY , `phone` VARCHAR(32) NOT NULL, `user_id` CHAR(36) BINARY, `token` VARCHAR(255) NOT NULL, `expires_at` DATETIME NOT NULL, `verified_at` DATETIME, `attempts` INTEGER NOT NULL DEFAULT 0, `created_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `phone_verifications` ADD INDEX `idx_phone_verification_phone_token` (`phone`, `token`)",
      "CREATE TABLE IF NOT EXISTS `post_tags` (`id` CHAR(36) BINARY , `post_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `created_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`post_id`) REFERENCES `feed_posts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `post_tags` ADD INDEX `post_tags_post_id` (`post_id`)",
      "ALTER TABLE `post_tags` ADD INDEX `post_tags_user_id` (`user_id`)",
      "ALTER TABLE `post_tags` ADD UNIQUE INDEX `post_tags_post_id_user_id` (`post_id`, `user_id`)",
      "CREATE TABLE IF NOT EXISTS `conversation_participants` (`id` CHAR(36) BINARY , `conversation_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `joined_at` DATETIME, UNIQUE `conversation_participants_user_id_conversation_id_unique` (`conversation_id`, `user_id`), PRIMARY KEY (`id`), FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `conversation_participants` ADD INDEX `conversation_participants_conversation_id` (`conversation_id`)",
      "ALTER TABLE `conversation_participants` ADD INDEX `conversation_participants_user_id` (`user_id`)",
      "ALTER TABLE `conversation_participants` ADD UNIQUE INDEX `conversation_participants_conversation_id_user_id` (`conversation_id`, `user_id`)",
      "CREATE TABLE IF NOT EXISTS `journal_entries` (`id` CHAR(36) BINARY , `household_id` CHAR(36) BINARY, `user_id` CHAR(36) BINARY, `content` TEXT, `mood` VARCHAR(16), `tags` JSON, `created_at` DATETIME, `updated_at` DATETIME, `deleted_at` DATETIME, PRIMARY KEY (`id`), FOREIGN KEY (`household_id`) REFERENCES `households` (`id`) ON DELETE SET NULL ON UPDATE CASCADE, FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
      "ALTER TABLE `journal_entries` ADD INDEX `idx_journal_entries_user_created` (`user_id`, `created_at`)",
      "CREATE TABLE IF NOT EXISTS `journal_media` (`id` CHAR(36) BINARY , `entry_id` CHAR(36) BINARY, `media_url` VARCHAR(500) NOT NULL, `media_type` ENUM('photo', 'video') NOT NULL, `thumbnail_url` VARCHAR(500), `file_size_bytes` INTEGER, `created_at` DATETIME, `updated_at` DATETIME NOT NULL, PRIMARY KEY (`id`), FOREIGN KEY (`entry_id`) REFERENCES `journal_entries` (`id`) ON DELETE SET NULL ON UPDATE CASCADE) ENGINE=InnoDB;",
    ];

// Every migration filename that predates this one — all of their changes
// are already baked into BASELINE_DDL above, so once this migration
// creates the schema fresh, these must be marked applied (not re-run).
const SUPERSEDED_MIGRATIONS = [
      "20260802-add-points-to-tasks.js",
      "20260803-create-calendar-invitees.js",
      "20260810-create-ping-requests.js",
      "20260811-create-saved-places.js",
      "20260812-add-household-scheduled-deletion.js",
      "20260813-add-calendar-sync-tokens.js",
      "20260814-add-household-conversation-type.js",
      "20260815-add-biweekly-task-recurrence.js",
      "20260815-add-cover-photo-to-households.js",
      "20260815-add-points-reduced-to-tasks.js",
      "20260820-add-timezone-to-households.js",
      "20260821-add-type-and-duration-to-chat-messages.js",
      "20260821-create-journal-tables.js",
      "20260822-add-live-share-to-ping-requests.js",
      "20260823-backfill-task-default-points-to-5.js",
      "20260824-remove-email-verification-token-unique.js",
      "20260824-vault-document-s3-key.js",
      "20260825-add-apple-id-to-users.js",
      "20260826-add-mood-and-tags-to-journal-entries.js",
      "20260901-harden-password-reset-otp.js",
      "20260905-create-household-action-requests.js",
      "20260908-create-phone-verifications-and-user-phone.js",
    ];

const TABLES_IN_DROP_ORDER = [
      "journal_media",
      "journal_entries",
      "conversation_participants",
      "post_tags",
      "phone_verifications",
      "device_tokens",
      "notification_history",
      "notification_preferences",
      "calendar_invitees",
      "calendar_sync_states",
      "calendar_events",
      "saved_places",
      "ping_requests",
      "check_ins",
      "chat_reactions",
      "chat_messages",
      "conversations",
      "vault_document_keys",
      "vault_keys",
      "vault_documents",
      "settlements",
      "expense_participants",
      "expenses",
      "todo_items",
      "grocery_items",
      "task_assignees",
      "tasks",
      "feed_media",
      "comment_reactions",
      "feed_comments",
      "feed_likes",
      "feed_posts",
      "invitations",
      "household_action_requests",
      "household_members",
      "households",
      "password_resets",
      "email_verifications",
      "refresh_tokens",
      "users",
    ];

// MySQL errnos meaning "this already exists": table, column, index/key name,
// foreign key constraint.
const ALREADY_EXISTS_ERRNOS = new Set([1050, 1060, 1061, 1826]);

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const statement of BASELINE_DDL) {
      try {
        await queryInterface.sequelize.query(statement);
      } catch (err) {
        // The schema (or part of it) is already there: a dev DB built by the
        // old sequelize.sync() boot, or an earlier run that died halfway
        // (MySQL DDL isn't transactional). Skip the pieces that exist, fail
        // on anything else.
        if (!ALREADY_EXISTS_ERRNOS.has(err?.original?.errno ?? err?.parent?.errno)) throw err;
      }
    }

    const tableName = queryInterface.sequelize.options.migrationStorageTableName || 'SequelizeMeta';
    const now = new Date();
    for (const name of SUPERSEDED_MIGRATIONS) {
      await queryInterface.sequelize.query(
        `INSERT IGNORE INTO \`${tableName}\` (name) VALUES (?)`,
        { replacements: [name] },
      );
    }
  },

  async down(queryInterface) {
    const tableName = queryInterface.sequelize.options.migrationStorageTableName || 'SequelizeMeta';
    for (const name of SUPERSEDED_MIGRATIONS) {
      await queryInterface.sequelize.query(
        `DELETE FROM \`${tableName}\` WHERE name = ?`,
        { replacements: [name] },
      );
    }

    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES_IN_DROP_ORDER) {
      await queryInterface.dropTable(table, { force: true });
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  },
};
