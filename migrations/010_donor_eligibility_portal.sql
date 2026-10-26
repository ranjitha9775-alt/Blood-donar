USE blood_donar_portal;

CREATE TABLE IF NOT EXISTS donor_eligibility_review_requests (
  request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donor_user_id INT NOT NULL,
  request_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by_admin_id TINYINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  instructions VARCHAR(500) NULL,
  PRIMARY KEY (request_id),
  KEY idx_eligibility_requests_status (request_status, requested_at),
  KEY idx_eligibility_requests_donor (donor_user_id, requested_at),
  CONSTRAINT fk_eligibility_request_donor FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_eligibility_request_admin FOREIGN KEY (reviewed_by_admin_id)
    REFERENCES admin_users (admin_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS donor_donation_history_corrections (
  correction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donation_id BIGINT UNSIGNED NOT NULL,
  donor_user_id INT NOT NULL,
  previous_donation_date DATE NOT NULL,
  corrected_donation_date DATE NOT NULL,
  corrected_by_admin_id TINYINT UNSIGNED NOT NULL,
  correction_note VARCHAR(500) NOT NULL,
  corrected_at DATETIME NOT NULL,
  PRIMARY KEY (correction_id),
  KEY idx_donation_corrections_record (donation_id, corrected_at),
  CONSTRAINT fk_donation_correction_record FOREIGN KEY (donation_id)
    REFERENCES donor_donation_history (donation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_donation_correction_donor FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_donation_correction_admin FOREIGN KEY (corrected_by_admin_id)
    REFERENCES admin_users (admin_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
