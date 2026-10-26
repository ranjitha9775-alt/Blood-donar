"use strict";

const { isValidDateOnly } = require("./donation-date");

function getDaysBetweenDates(startDate, endDate) {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) return null;
  return Math.floor(
    (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
      86400000
  );
}

function getRecoveryProgress(lastDonationDate, nextReviewDate, today) {
  if (!lastDonationDate || !nextReviewDate) {
    return { daysSinceDonation: null, totalRecoveryDays: null, progressPercent: 0 };
  }
  const daysSinceDonation = getDaysBetweenDates(lastDonationDate, today);
  const totalRecoveryDays = getDaysBetweenDates(lastDonationDate, nextReviewDate);
  if (daysSinceDonation === null || totalRecoveryDays === null || totalRecoveryDays <= 0) {
    return { daysSinceDonation: null, totalRecoveryDays: null, progressPercent: 0 };
  }
  return {
    daysSinceDonation: Math.max(0, daysSinceDonation),
    totalRecoveryDays,
    progressPercent: Math.min(100, Math.floor(Math.max(0, daysSinceDonation) / totalRecoveryDays * 100))
  };
}

function getEligibilityPortalStatus({
  lastDonationDate,
  nextReviewDate,
  today,
  latestDecision,
  decisionAfterDonation,
  screeningCleared,
  requestStatus
}) {
  if (latestDecision === "deferred" && decisionAfterDonation) return "temporarily_ineligible";
  if (lastDonationDate && nextReviewDate && nextReviewDate > today) {
    return "recovery_period_in_progress";
  }
  if (latestDecision === "eligible" && decisionAfterDonation) return "eligibility_confirmed";
  if (["pending", "approved"].includes(requestStatus)) return "awaiting_eligibility_review";
  if (screeningCleared) return "eligible_for_review";
  return "medical_review_required";
}

function canRequestEligibilityReview({
  today,
  nextReviewDate,
  screeningCleared,
  requestStatus,
  eligibilityConfirmed
}) {
  return isValidDateOnly(today) &&
    (!nextReviewDate || (isValidDateOnly(nextReviewDate) && nextReviewDate <= today)) &&
    screeningCleared === true &&
    !["pending", "approved"].includes(requestStatus) &&
    eligibilityConfirmed !== true;
}

function isMatchingEligibilityConfirmed({
  decision,
  reviewedAt,
  lastDonationVerifiedAt,
  lastConfirmedAt
}) {
  if (decision !== "eligible" || !reviewedAt || !lastConfirmedAt) return false;
  const reviewedTime = Date.parse(reviewedAt);
  const confirmedTime = Date.parse(lastConfirmedAt);
  const donationTime = lastDonationVerifiedAt ? Date.parse(lastDonationVerifiedAt) : 0;
  return Number.isFinite(reviewedTime) &&
    Number.isFinite(confirmedTime) &&
    (!lastDonationVerifiedAt || Number.isFinite(donationTime)) &&
    reviewedTime >= donationTime &&
    confirmedTime >= reviewedTime;
}

module.exports = {
  canRequestEligibilityReview,
  getDaysBetweenDates,
  getEligibilityPortalStatus,
  getRecoveryProgress,
  isMatchingEligibilityConfirmed
};
