"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateStock,
  getStockStatus,
  isStockFreshForUtcDate
} = require("./stock-utils");

test("calculates eligible and available stock", () => {
  assert.deepEqual(calculateStock({ physical: 100, reserved: 15, issued: 20, discarded: 5 }), {
    eligible: 75,
    unavailable: 25,
    available: 60
  });
});

test("rejects stock outflows above physical count", () => {
  assert.throws(() => calculateStock({ physical: 10, reserved: 3, issued: 6, discarded: 2 }), RangeError);
  assert.throws(() => calculateStock({ physical: -1, reserved: 0, issued: 0, discarded: 0 }), RangeError);
});

test("does not report stale or unverified figures as current", () => {
  assert.equal(getStockStatus({ available: 20, threshold: 5, verified: false, stale: false }), "Pending Verification");
  assert.equal(getStockStatus({ available: 20, threshold: 5, verified: true, stale: true }), "Outdated");
  assert.equal(getStockStatus({ available: 20, threshold: 5, verified: false, stale: true }), "Outdated");
  assert.equal(getStockStatus({ available: 0, threshold: 5, verified: true, stale: false }), "Out of Stock");
  assert.equal(getStockStatus({ available: 4, threshold: 5, verified: true, stale: false }), "Low Stock");
});

test("stock is fresh only when its update date matches the current UTC date", () => {
  const now = new Date("2026-10-26T00:15:00.000Z");
  assert.equal(isStockFreshForUtcDate("2026-10-26T00:01:00.000Z", now), true);
  assert.equal(isStockFreshForUtcDate("2026-10-25T23:59:59.000Z", now), false);
  assert.equal(isStockFreshForUtcDate(null, now), false);
});