USE blood_donar_portal;

ALTER TABLE donors
  ADD COLUMN availability_starts_at DATETIME NULL AFTER last_confirmed_at,
  ADD KEY idx_donors_availability_window
    (blood_group, state, city, availability_starts_at, availability_expires_at);

UPDATE donors
SET availability_starts_at = last_confirmed_at
WHERE availability_starts_at IS NULL
  AND last_confirmed_at IS NOT NULL
  AND availability_expires_at IS NOT NULL;
