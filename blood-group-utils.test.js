"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  areBloodGroupsCompatible,
  getCompatibleDonorBloodGroups
} = require("./blood-group-utils");

test("only returns an exact validated blood-group match", () => {
  for (const group of ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]) {
    assert.equal(areBloodGroupsCompatible(group, group), true);
    assert.deepEqual(getCompatibleDonorBloodGroups(group), [group]);
  }
  assert.equal(areBloodGroupsCompatible("O-", "AB+"), false);
  assert.equal(areBloodGroupsCompatible("invalid", "invalid"), false);
  assert.deepEqual(getCompatibleDonorBloodGroups("invalid"), []);
});
