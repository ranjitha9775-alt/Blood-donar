USE blood_donar_portal;

ALTER TABLE donors
  ADD COLUMN public_phone_consent TINYINT(1) NOT NULL DEFAULT 0
  AFTER public_identity_consent;
