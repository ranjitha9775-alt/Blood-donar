"use strict";

function canAccessBloodBankPortal(user, assignedBank) {
  return user?.role === "blood_bank" &&
    Number.isSafeInteger(Number(user.user_id)) &&
    Boolean(assignedBank) &&
    Number.isSafeInteger(Number(assignedBank.bank_id)) &&
    Number(assignedBank.bank_id) > 0 &&
    (assignedBank.is_active === true ||
      assignedBank.is_active === 1 ||
      assignedBank.is_active === "1");
}

module.exports = { canAccessBloodBankPortal };
