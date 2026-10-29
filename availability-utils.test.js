"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAvailabilitySearchEligible,
  isValidAvailabilityConfirmationHours,
  parseAvailabilityWindow,
  normalizeAvailabilityState
} = require("./availability-utils");

test("availability confirmations use a fixed 24-hour period", () => {
  assert.equal(isValidAvailabilityConfirmationHours(24), true);
  assert.equal(isValidAvailabilityConfirmationHours(4), false);
  assert.equal(isValidAvailabilityConfirmationHours(12), false);
  assert.equal(isValidAvailabilityConfirmationHours("24"), false);
});

test("validates scheduled availability windows and serializes them in UTC", () => {
  const now = Date.parse("2026-10-29T10:00:00.000Z");
  assert.deepEqual(
    parseAvailabilityWindow(
      "2026-10-29T10:15:00.000Z",
      "2026-10-30T10:15:00.000Z",
      now
    ),
    { startsAt: "2026-10-29 10:15:00", endsAt: "2026-10-30 10:15:00" }
  );
  assert.equal(parseAvailabilityWindow(
    "2026-10-29T09:59:00.000Z",
    "2026-10-30T10:15:00.000Z",
    now
  ), null);
  assert.equal(parseAvailabilityWindow(
    "2026-10-29T10:15:00.000Z",
    "2026-10-29T10:15:00.000Z",
    now
  ), null);
  assert.equal(parseAvailabilityWindow(
    "2026-10-29T10:15:00.000Z",
    "2027-11-01T10:15:00.000Z",
    now
  ), null);
  assert.equal(parseAvailabilityWindow("not-a-date", "2026-10-30T10:15:00.000Z", now), null);
});

test("normalizes the three donor availability states", () => {
  assert.equal(normalizeAvailabilityState("Available"), "available");
  assert.equal(normalizeAvailabilityState("Not Available"), "not_available");
  assert.equal(normalizeAvailabilityState("temporarily-unavailable"), "temporarily_unavailable");
  assert.equal(normalizeAvailabilityState("unknown"), "");
});

test("requires every confirmation, eligibility, and consent gate for search", () => {
  const eligible = {
    state: "available",
    confirmed: true,
    current: true,
    eligible: true,
    contactConsent: true,
    identityConsent: true
  };
  assert.equal(isAvailabilitySearchEligible(eligible), true);
  for (const key of ["confirmed", "current", "eligible", "contactConsent", "identityConsent"]) {
    assert.equal(isAvailabilitySearchEligible({ ...eligible, [key]: false }), false);
  }
  for (const state of ["not_available", "temporarily_unavailable", "unconfirmed"]) {
    assert.equal(isAvailabilitySearchEligible({ ...eligible, state }), false);
  }
});
