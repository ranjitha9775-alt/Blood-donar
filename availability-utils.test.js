"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAvailabilitySearchEligible,
  normalizeAvailabilityState
} = require("./availability-utils");

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
