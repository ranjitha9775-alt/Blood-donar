ALTER TABLE donors
  ADD COLUMN availability_status ENUM('available', 'not_available')
    NOT NULL DEFAULT 'not_available' AFTER availability_expires_at,
  ADD COLUMN last_confirmed_at DATETIME NULL AFTER availability_status,
  ADD COLUMN availability_updated_at TIMESTAMP NOT NULL
    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER last_confirmed_at,
  ADD COLUMN emergency_response_consent TINYINT(1) NOT NULL DEFAULT 0
    AFTER availability_updated_at;

CREATE TABLE IF NOT EXISTS donor_request_responses (
  request_id BIGINT UNSIGNED NOT NULL,
  donor_user_id BIGINT UNSIGNED NOT NULL,
  response ENUM('pending', 'can_help', 'cannot_help') NOT NULL DEFAULT 'pending',
  matched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  response_deadline DATETIME NOT NULL,
  responded_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, donor_user_id),
  KEY idx_donor_responses_donor (donor_user_id, matched_at),
  CONSTRAINT fk_donor_responses_request FOREIGN KEY (request_id)
    REFERENCES blood_requests (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_donor_responses_user FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
