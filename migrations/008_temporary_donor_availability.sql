USE blood_donar_portal;

ALTER TABLE donors
  MODIFY COLUMN availability_status
    ENUM('available', 'not_available', 'temporarily_unavailable')
    NOT NULL DEFAULT 'not_available';
