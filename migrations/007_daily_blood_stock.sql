USE blood_donar_portal;

ALTER TABLE blood_requests
  MODIFY COLUMN coordination_status
    ENUM('Pending', 'Under Review', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled')
    NOT NULL DEFAULT 'Pending';

ALTER TABLE blood_stock
  ADD COLUMN component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma')
    NOT NULL DEFAULT 'whole_blood' AFTER blood_group,
  ADD COLUMN physical_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER units_available,
  ADD COLUMN reserved_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER physical_units,
  ADD COLUMN issued_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER reserved_units,
  ADD COLUMN discarded_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER issued_units,
  ADD COLUMN total_eligible_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER discarded_units,
  ADD COLUMN available_units INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_eligible_units,
  ADD COLUMN low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0 AFTER available_units,
  ADD COLUMN verification_status ENUM('pending', 'verified', 'rejected')
    NOT NULL DEFAULT 'pending' AFTER low_stock_threshold,
  ADD COLUMN updated_by INT NULL AFTER verification_status;

ALTER TABLE blood_stock
  ADD UNIQUE KEY uq_blood_stock_bank_group_component
    (blood_bank_id, blood_group, component);

ALTER TABLE blood_stock
  DROP INDEX uq_bank_blood_group,
  ADD KEY idx_blood_stock_public_search
    (blood_group, component, verification_status, last_updated);

CREATE TABLE stock_history (
  history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_id INT NOT NULL,
  blood_bank_id INT NOT NULL,
  blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
  previous_physical_units INT UNSIGNED NOT NULL,
  physical_units INT UNSIGNED NOT NULL,
  previous_reserved_units INT UNSIGNED NOT NULL,
  reserved_units INT UNSIGNED NOT NULL,
  previous_issued_units INT UNSIGNED NOT NULL,
  issued_units INT UNSIGNED NOT NULL,
  previous_discarded_units INT UNSIGNED NOT NULL,
  discarded_units INT UNSIGNED NOT NULL,
  previous_available_units INT UNSIGNED NOT NULL,
  available_units INT UNSIGNED NOT NULL,
  transaction_type ENUM('daily_update', 'correction') NOT NULL DEFAULT 'daily_update',
  quantity_changed INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  remarks VARCHAR(500) NULL,
  staff_user_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (history_id),
  UNIQUE KEY uq_stock_history_idempotency (idempotency_key),
  KEY idx_stock_history_bank_date (blood_bank_id, created_at),
  KEY idx_stock_history_stock_date (stock_id, created_at),
  CONSTRAINT fk_stock_history_stock FOREIGN KEY (stock_id)
    REFERENCES blood_stock (stock_id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_history_bank FOREIGN KEY (blood_bank_id)
    REFERENCES blood_banks (blood_bank_id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_history_staff FOREIGN KEY (staff_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blood_stock_thresholds (
  blood_bank_id INT NOT NULL,
  blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
  low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by_admin_id TINYINT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (blood_bank_id, blood_group, component),
  CONSTRAINT fk_stock_threshold_bank FOREIGN KEY (blood_bank_id)
    REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_threshold_admin FOREIGN KEY (updated_by_admin_id)
    REFERENCES admin_users (admin_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blood_stock_alerts (
  alert_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id INT NOT NULL,
  scope_key VARCHAR(32) NOT NULL,
  blood_group VARCHAR(3) NULL,
  component VARCHAR(20) NULL,
  alert_type ENUM('low_stock', 'out_of_stock', 'update_required', 'unverified') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  message VARCHAR(255) NOT NULL,
  first_triggered_at DATETIME NOT NULL,
  last_triggered_at DATETIME NOT NULL,
  resolved_at DATETIME NULL,
  PRIMARY KEY (alert_id),
  UNIQUE KEY uq_stock_alert_scope (blood_bank_id, scope_key, alert_type),
  KEY idx_stock_alert_active (is_active, blood_bank_id, alert_type),
  CONSTRAINT fk_stock_alert_bank FOREIGN KEY (blood_bank_id)
    REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blood_bank_notifications (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_user_id INT NOT NULL,
  request_id INT NOT NULL,
  notification_type ENUM('emergency_request') NOT NULL DEFAULT 'emergency_request',
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id),
  UNIQUE KEY uq_bank_request_notification (staff_user_id, request_id, notification_type),
  KEY idx_bank_notifications_unread (staff_user_id, read_at, created_at),
  CONSTRAINT fk_bank_notification_staff FOREIGN KEY (staff_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_bank_notification_request FOREIGN KEY (request_id)
    REFERENCES blood_requests (request_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blood_stock_threshold_history (
  threshold_history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blood_bank_id INT NOT NULL,
  blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma') NOT NULL,
  previous_threshold INT UNSIGNED NULL,
  new_threshold INT UNSIGNED NOT NULL,
  updated_by_admin_id TINYINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (threshold_history_id),
  KEY idx_stock_threshold_history (blood_bank_id, blood_group, component, created_at),
  CONSTRAINT fk_stock_threshold_history_bank FOREIGN KEY (blood_bank_id)
    REFERENCES blood_banks (blood_bank_id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_threshold_history_admin FOREIGN KEY (updated_by_admin_id)
    REFERENCES admin_users (admin_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;