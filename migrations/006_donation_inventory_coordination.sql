USE blood_donar_portal;

ALTER TABLE donors
  ADD COLUMN next_eligible_date DATE NULL AFTER last_donation_date;

ALTER TABLE donor_health_screenings
  ADD COLUMN health_data_consent_at DATETIME NULL AFTER review_notes,
  ADD COLUMN form_version VARCHAR(20) NULL AFTER health_data_consent_at;

CREATE TABLE donor_donation_history (
  donation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donor_user_id INT NOT NULL,
  donation_date DATE NOT NULL,
  eligibility_interval_months SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  next_eligible_date DATE NOT NULL,
  verification_status ENUM('verified', 'rejected') NOT NULL DEFAULT 'verified',
  recorded_by_admin_username VARCHAR(80) NOT NULL,
  verified_by_admin_username VARCHAR(80) NOT NULL,
  verified_at DATETIME NOT NULL,
  notes VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (donation_id),
  KEY idx_donation_history_donor (donor_user_id, donation_date),
  KEY idx_donation_history_eligibility (donor_user_id, next_eligible_date, verification_status),
  CONSTRAINT fk_donation_history_donor FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE donor_eligibility_reviews (
  review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donor_user_id INT NOT NULL,
  decision ENUM('eligible', 'deferred') NOT NULL,
  reviewed_by_user_id INT NOT NULL,
  reviewed_at DATETIME NOT NULL,
  notes VARCHAR(500) NULL,
  PRIMARY KEY (review_id),
  KEY idx_eligibility_review_donor (donor_user_id, reviewed_at),
  CONSTRAINT fk_eligibility_review_donor FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_eligibility_review_staff FOREIGN KEY (reviewed_by_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE blood_requests
  ADD COLUMN component ENUM('whole_blood', 'red_cells', 'platelets', 'plasma')
    NOT NULL DEFAULT 'whole_blood' AFTER blood_group,
  ADD COLUMN coordination_status ENUM('Pending', 'Accepted', 'Rejected', 'In Progress', 'Fulfilled', 'Cancelled')
    NOT NULL DEFAULT 'Pending' AFTER status,
  ADD COLUMN coordinator_user_id INT NULL AFTER coordination_status,
  ADD COLUMN coordinator_bank_id INT NULL AFTER coordinator_user_id,
  ADD COLUMN coordination_updated_at DATETIME NULL AFTER coordinator_bank_id;

ALTER TABLE blood_inventory
  ADD COLUMN low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0 AFTER available_units;

UPDATE blood_requests
SET coordination_status = CASE
  WHEN LOWER(status) = 'fulfilled' THEN 'Fulfilled'
  WHEN LOWER(status) = 'cancelled' THEN 'Cancelled'
  WHEN LOWER(status) IN ('accepted', 'in progress') THEN status
  ELSE 'Pending'
END;

CREATE TABLE blood_request_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT NOT NULL,
  actor_user_id INT NULL,
  event_type VARCHAR(40) NOT NULL,
  previous_status VARCHAR(32) NULL,
  new_status VARCHAR(32) NULL,
  details JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  KEY idx_request_events_request (request_id, created_at),
  CONSTRAINT fk_request_events_request FOREIGN KEY (request_id)
    REFERENCES blood_requests (request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_request_events_actor FOREIGN KEY (actor_user_id)
    REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;