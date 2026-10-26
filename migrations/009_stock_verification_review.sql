USE blood_donar_portal;

ALTER TABLE blood_stock
  ADD COLUMN reviewed_by_admin_id TINYINT UNSIGNED NULL AFTER updated_by,
  ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by_admin_id;
