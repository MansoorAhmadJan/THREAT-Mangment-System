-- Select and verify the target database in this session before running this file.
-- Follow 002_add_user_sessions.md for migration order and partial failure recovery.
ALTER TABLE `users`
  ADD COLUMN `disabled_at` datetime(6) DEFAULT NULL;

CREATE TABLE `user_sessions` (
  `session_hash` binary(32) NOT NULL,
  `user_id` int NOT NULL,
  `expires_at` bigint unsigned NOT NULL,
  PRIMARY KEY (`session_hash`),
  KEY `idx_user_sessions_user_id` (`user_id`),
  KEY `idx_user_sessions_expires_at` (`expires_at`),
  CONSTRAINT `fk_user_sessions_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB;
