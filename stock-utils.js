"use strict";

function getUtcDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function isStockFreshForUtcDate(lastUpdated, now = new Date()) {
  const stockDate = getUtcDate(lastUpdated);
  return stockDate !== null && stockDate === getUtcDate(now);
}

function calculateStock({ physical, reserved, issued, discarded }) {
  const quantities = [physical, reserved, issued, discarded];
  if (quantities.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("Stock quantities must be non-negative safe integers.");
  }
  if (reserved + issued + discarded > physical) {
    throw new RangeError("Reserved, issued, and discarded units cannot exceed physical stock.");
  }
  const eligible = physical - issued - discarded;
  return {
    eligible,
    unavailable: issued + discarded,
    available: eligible - reserved
  };
}

function getStockStatus({ available, threshold, verified, stale, requiredUnits = 0 }) {
  if (stale) return "Outdated";
  if (!verified) return "Pending Verification";
  if (available === 0) return "Out of Stock";
  if (available < threshold || (requiredUnits > 0 && available < requiredUnits)) return "Low Stock";
  return "Available";
}

module.exports = { calculateStock, getStockStatus, isStockFreshForUtcDate };