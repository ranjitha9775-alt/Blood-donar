"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canRequestEligibilityReview,
  getEligibilityPortalStatus,
  getRecoveryProgress,
  isMatchingEligibilityConfirmed
} = require("./eligibility-portal-utils");

test("tracks recovery days and caps progress without treating it as medical clearance", () => {
  assert.deepEqual(getRecoveryProgress("2024-01-31", "2024-04-30", "2024-03-15"), {
    daysSinceDonation: 44,
    totalRecoveryDays: 90,
    progressPercent: 48
  });
  assert.equal(getRecoveryProgress("2024-01-31", "2024-04-30", "2024-05-01").progressPercent, 100);
});

test("uses recovery and review states without automatically confirming eligibility", () => {
  const base = {
    lastDonationDate: "2026-07-26",
    nextReviewDate: "2026-10-26",
    today: "2026-10-26",
    latestDecision: null,
    decisionAfterDonation: false,
    screeningCleared: true,
    requestStatus: null
  };
  assert.equal(getEligibilityPortalStatus({ ...base, today: "2026-10-25" }), "recovery_period_in_progress");
  assert.equal(getEligibilityPortalStatus(base), "eligible_for_review");
  assert.equal(getEligibilityPortalStatus({ ...base, requestStatus: "pending" }), "awaiting_eligibility_review");
  assert.equal(getEligibilityPortalStatus({ ...base, requestStatus: "approved" }), "awaiting_eligibility_review");
  assert.equal(getEligibilityPortalStatus({ ...base, latestDecision: "eligible", decisionAfterDonation: true }), "eligibility_confirmed");
  assert.equal(getEligibilityPortalStatus({ ...base, screeningCleared: false }), "medical_review_required");
  assert.equal(getEligibilityPortalStatus({ ...base, latestDecision: "deferred", decisionAfterDonation: true }), "temporarily_ineligible");
});

test("a donation recorded today starts recovery immediately and does not imply eligibility", () => {
  const today = "2026-10-26";
  const nextReviewDate = "2027-01-26";
  assert.equal(getEligibilityPortalStatus({
    lastDonationDate: today,
    nextReviewDate,
    today,
    latestDecision: "eligible",
    decisionAfterDonation: false,
    screeningCleared: true,
    requestStatus: null
  }), "recovery_period_in_progress");
  assert.deepEqual(getRecoveryProgress(today, nextReviewDate, today), {
    daysSinceDonation: 0,
    totalRecoveryDays: 92,
    progressPercent: 0
  });
});

test("review requests require recovery to finish and screening clearance", () => {
  const base = {
    today: "2026-10-26",
    nextReviewDate: "2026-10-26",
    screeningCleared: true,
    requestStatus: null,
    eligibilityConfirmed: false
  };
  assert.equal(canRequestEligibilityReview(base), true);
  assert.equal(canRequestEligibilityReview({ ...base, nextReviewDate: "2026-10-27" }), false);
  assert.equal(canRequestEligibilityReview({ ...base, screeningCleared: false }), false);
  assert.equal(canRequestEligibilityReview({ ...base, requestStatus: "pending" }), false);
  assert.equal(canRequestEligibilityReview({ ...base, requestStatus: "approved" }), false);
});

test("matching returns only after staff approval and an explicit later confirmation", () => {
  const base = {
    decision: "eligible",
    reviewedAt: "2026-10-26T10:00:00.000Z",
    lastDonationVerifiedAt: "2026-07-26T10:00:00.000Z",
    lastConfirmedAt: "2026-10-26T10:01:00.000Z"
  };
  assert.equal(isMatchingEligibilityConfirmed(base), true);
  assert.equal(isMatchingEligibilityConfirmed({ ...base, lastConfirmedAt: "2026-10-26T09:59:00.000Z" }), false);
  assert.equal(isMatchingEligibilityConfirmed({ ...base, decision: "deferred" }), false);
  assert.equal(isMatchingEligibilityConfirmed({ ...base, reviewedAt: "2026-07-25T10:00:00.000Z" }), false);
});
