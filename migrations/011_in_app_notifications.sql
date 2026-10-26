USE blood_donar_portal;

CREATE TABLE IF NOT EXISTS in_app_notifications (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recipient_user_id INT NULL,
  recipient_admin_id TINYINT UNSIGNED NULL,
  title VARCHAR(120) NOT NULL,
  message VARCHAR(500) NOT NULL,
  notification_type VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  related_request_id INT NULL,
  dedupe_key VARCHAR(160) NOT NULL,
  PRIMARY KEY (notification_id),
  UNIQUE KEY uq_user_notification_dedupe (recipient_user_id, dedupe_key),
  UNIQUE KEY uq_admin_notification_dedupe (recipient_admin_id, dedupe_key),
  KEY idx_user_notifications_unread (recipient_user_id, read_at, created_at),
  KEY idx_admin_notifications_unread (recipient_admin_id, read_at, created_at),
  CONSTRAINT fk_notification_recipient_user FOREIGN KEY (recipient_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_recipient_admin FOREIGN KEY (recipient_admin_id)
    REFERENCES admin_users (admin_id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_request FOREIGN KEY (related_request_id)
    REFERENCES blood_requests (request_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
