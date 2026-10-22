ALTER TABLE blood_requests
  ADD COLUMN hospital_name VARCHAR(150) NOT NULL DEFAULT '' AFTER hospital_details;

ALTER TABLE donor_request_responses
  ADD COLUMN read_at DATETIME NULL AFTER responded_at,
  ADD COLUMN contact_sharing_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER read_at,
  ADD KEY idx_donor_response_unread (donor_user_id, read_at, matched_at);
