"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addCalendarMonths,
  getDonationEligibilityStatus,
  isValidDateOnly,
  isValidDonationDate
} = require("./donation-date");

test("adds calendar months and clamps month-end dates", () => {
  assert.equal(addCalendarMonths("2024-11-30", 3), "2025-02-28");
  assert.equal(addCalendarMonths("2024-01-31", 1), "2024-02-29");
});

test("preserves valid days across leap years", () => {
  assert.equal(addCalendarMonths("2024-02-29", 12), "2025-02-28");
  assert.equal(addCalendarMonths("2024-05-15", 3), "2024-08-15");
});

test("validates date-only calendar values and rejects future donation dates", () => {
  assert.equal(isValidDateOnly("2024-02-29"), true);
  assert.equal(isValidDateOnly("2025-02-29"), false);
  assert.equal(isValidDateOnly("2025-2-09"), false);
  assert.equal(isValidDonationDate("2025-01-01", "2025-01-01"), true);
  assert.equal(isValidDonationDate("2025-01-02", "2025-01-01"), false);
  assert.throws(() => addCalendarMonths("not-a-date", 3), RangeError);
});

test("passing the interval date requires review rather than auto-certifying eligibility", () => {
  assert.equal(getDonationEligibilityStatus("2025-01-02", "2025-01-01"), "in_cooldown");
  assert.equal(getDonationEligibilityStatus("2025-01-01", "2025-01-01"), "awaiting_review");
  assert.equal(getDonationEligibilityStatus("invalid", "2025-01-01"), "unknown");
});