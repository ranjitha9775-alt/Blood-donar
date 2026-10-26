"use strict";

const BLOOD_GROUPS = new Set(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);

function areBloodGroupsCompatible(donorBloodGroup, requestedBloodGroup) {
  return BLOOD_GROUPS.has(donorBloodGroup) &&
    BLOOD_GROUPS.has(requestedBloodGroup) &&
    donorBloodGroup === requestedBloodGroup;
}

function getCompatibleDonorBloodGroups(requestedBloodGroup) {
  return [...BLOOD_GROUPS].filter(group =>
    areBloodGroupsCompatible(group, requestedBloodGroup)
  );
}

module.exports = { areBloodGroupsCompatible, getCompatibleDonorBloodGroups };
