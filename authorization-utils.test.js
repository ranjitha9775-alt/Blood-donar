"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canAccessBloodBankPortal } = require("./authorization-utils");

test("blood-bank portal requires the staff role and an assigned active bank", () => {
  const user = { user_id: 10, role: "blood_bank" };
  assert.equal(canAccessBloodBankPortal(user, { bank_id: 3, is_active: 1 }), true);
  assert.equal(canAccessBloodBankPortal({ ...user, role: "donor" }, { bank_id: 3, is_active: 1 }), false);
  assert.equal(canAccessBloodBankPortal({ ...user, role: "admin" }, { bank_id: 3, is_active: 1 }), false);
  assert.equal(canAccessBloodBankPortal(user, null), false);
  assert.equal(canAccessBloodBankPortal(user, { bank_id: 0, is_active: 1 }), false);
  assert.equal(canAccessBloodBankPortal(user, { bank_id: 3, is_active: 0 }), false);
});
