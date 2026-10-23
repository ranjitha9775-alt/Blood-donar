USE blood_donar_portal;

ALTER TABLE users
  MODIFY COLUMN role ENUM('donor', 'recipient', 'patient', 'blood_bank', 'admin')
  NOT NULL DEFAULT 'recipient';

CREATE TABLE IF NOT EXISTS donor_request_responses (
  request_id INT NOT NULL,
  donor_user_id INT NOT NULL,
  response ENUM('pending', 'can_help', 'cannot_help', 'busy', 'declined', 'expired')
    NOT NULL DEFAULT 'pending',
  matched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  response_deadline DATETIME NOT NULL,
  responded_at DATETIME NULL,
  read_at DATETIME NULL,
  contact_sharing_consent TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, donor_user_id),
  KEY idx_donor_responses_donor (donor_user_id, matched_at),
  KEY idx_donor_response_unread (donor_user_id, read_at, matched_at),
  CONSTRAINT fk_donor_responses_request FOREIGN KEY (request_id)
    REFERENCES blood_requests (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_donor_responses_user FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE donor_request_responses
  MODIFY COLUMN response
    ENUM('pending', 'can_help', 'cannot_help', 'busy', 'declined', 'expired')
    NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS donor_availability_dates (
  donor_user_id INT NOT NULL,
  available_date DATE NOT NULL,
  status ENUM('available', 'unavailable') NOT NULL DEFAULT 'available',
  confirmed_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (donor_user_id, available_date),
  KEY idx_donor_availability_date (available_date, status),
  CONSTRAINT fk_donor_availability_dates_user FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS donor_availability_date_history (
  history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donor_user_id INT NOT NULL,
  available_date DATE NOT NULL,
  previous_status VARCHAR(20) NULL,
  new_status VARCHAR(20) NOT NULL,
  changed_at DATETIME NOT NULL,
  PRIMARY KEY (history_id),
  KEY idx_availability_date_history (donor_user_id, available_date, changed_at),
  CONSTRAINT fk_availability_date_history_user FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS donor_health_screenings (
  screening_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  donor_user_id INT NOT NULL,
  responses JSON NOT NULL,
  review_status ENUM('Pending Review', 'Cleared', 'Not Cleared')
    NOT NULL DEFAULT 'Pending Review',
  submitted_at DATETIME NOT NULL,
  reviewed_at DATETIME NULL,
  reviewed_by_user_id INT NULL,
  review_notes VARCHAR(500) NULL,
  PRIMARY KEY (screening_id),
  KEY idx_donor_screening_owner (donor_user_id, submitted_at),
  KEY idx_donor_screening_review (review_status, submitted_at),
  CONSTRAINT fk_donor_screening_user FOREIGN KEY (donor_user_id)
    REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_donor_screening_reviewer FOREIGN KEY (reviewed_by_user_id)
    REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
