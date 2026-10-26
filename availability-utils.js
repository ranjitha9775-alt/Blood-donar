"use strict";

const AVAILABILITY_STATES = new Set([
  "available",
  "not_available",
  "temporarily_unavailable"
]);

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

module.exports = { isAvailabilitySearchEligible, normalizeAvailabilityState };
