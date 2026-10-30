"use strict";

const AVAILABILITY_STATES = new Set([
  "available",
  "not_available",
  "temporarily_unavailable"
]);
const MAX_AVAILABILITY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const AVAILABILITY_CONFIRMATION_HOURS = 42;
const AVAILABILITY_CONFIRMATION_MS = AVAILABILITY_CONFIRMATION_HOURS * 60 * 60 * 1000;
const UNAVAILABILITY_REASONS = new Set([
  "recently_donated",
  "health_reasons",
  "work_studies",
  "temporarily_unavailable",
  "other"
]);

function isValidAvailabilityConfirmationHours(value) {
  return value === AVAILABILITY_CONFIRMATION_HOURS;
}

function getDefaultAvailabilityWindow(now = Date.now()) {
  const startsAt = new Date(now);
  if (!Number.isFinite(startsAt.getTime())) {
    throw new RangeError("A valid time is required for a default availability window.");
  }
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + AVAILABILITY_CONFIRMATION_MS)
  };
}

function parseAvailabilityWindow(startAt, endAt, now = Date.now()) {
  const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (typeof startAt !== "string" || typeof endAt !== "string" ||
      !isoUtcPattern.test(startAt) || !isoUtcPattern.test(endAt)) {
    return null;
  }
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      new Date(start).toISOString() !== startAt ||
      new Date(end).toISOString() !== endAt ||
      start <= now || end <= start || end - start > MAX_AVAILABILITY_WINDOW_MS) {
    return null;
  }
  return {
    startsAt: new Date(start).toISOString().slice(0, 19).replace("T", " "),
    endsAt: new Date(end).toISOString().slice(0, 19).replace("T", " ")
  };
}

function parseExpectedAvailability(value, now = Date.now()) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value ||
      timestamp <= now || timestamp - now > MAX_AVAILABILITY_WINDOW_MS) {
    return null;
  }
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

function isValidUnavailabilityReason(value) {
  return typeof value === "string" && UNAVAILABILITY_REASONS.has(value);
}

function normalizeAvailabilityState(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "unavailable") return "not_available";
  return AVAILABILITY_STATES.has(normalized) ? normalized : "";
}

function isAvailabilitySearchEligible({
  state,
  confirmed,
  current,
  eligible,
  contactConsent
}) {
  return normalizeAvailabilityState(state) === "available" &&
    confirmed === true &&
    current === true &&
    eligible === true &&
    contactConsent === true;
}

function getAdminAvailabilityConfirmationBlocker({
  availabilityState,
  searchConsent,
  cooldownClear,
  medicallyEligible,
  mode,
  validGeneralWindow,
  validSelectedDates
}) {
  if (availabilityState !== "unconfirmed") {
    return "Only availability that is awaiting confirmation can be confirmed.";
  }
  if (searchConsent !== true) return "The donor has not opted into patient search.";
  if (cooldownClear !== true || medicallyEligible !== true) {
    return "The donor must complete the donation cooldown, current screening, and qualified-staff eligibility review.";
  }
  if (mode === "general" && validGeneralWindow === true) return "";
  if (mode === "selected_dates" && validSelectedDates === true) return "";
  return "The donor must have a valid future availability window or at least one saved available date.";
}

module.exports = {
  isAvailabilitySearchEligible,
  getAdminAvailabilityConfirmationBlocker,
  getDefaultAvailabilityWindow,
  isValidUnavailabilityReason,
  isValidAvailabilityConfirmationHours,
  parseExpectedAvailability,
  parseAvailabilityWindow,
  normalizeAvailabilityState
};
