"use strict";

const AVAILABILITY_STATES = new Set([
  "available",
  "not_available",
  "temporarily_unavailable"
]);
const MAX_AVAILABILITY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

function isValidAvailabilityConfirmationHours(value) {
  return value === 24;
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
      start < now || end <= start || end - start > MAX_AVAILABILITY_WINDOW_MS) {
    return null;
  }
  return {
    startsAt: new Date(start).toISOString().slice(0, 19).replace("T", " "),
    endsAt: new Date(end).toISOString().slice(0, 19).replace("T", " ")
  };
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
  contactConsent,
  identityConsent
}) {
  return normalizeAvailabilityState(state) === "available" &&
    confirmed === true &&
    current === true &&
    eligible === true &&
    contactConsent === true &&
    identityConsent === true;
}

module.exports = {
  isAvailabilitySearchEligible,
  isValidAvailabilityConfirmationHours,
  parseAvailabilityWindow,
  normalizeAvailabilityState
};
