"use strict";

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidDonationDate(value, today) {
  return isValidDateOnly(value) && isValidDateOnly(today) && value <= today;
}

function addCalendarMonths(value, months) {
  if (!isValidDateOnly(value) || !Number.isInteger(months) || months < 0) {
    throw new RangeError("A valid date and non-negative whole month interval are required.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function getDonationEligibilityStatus(nextEligibleDate, today) {
  if (!isValidDateOnly(nextEligibleDate) || !isValidDateOnly(today)) return "unknown";
  return nextEligibleDate > today ? "in_cooldown" : "awaiting_review";
}

module.exports = {
  addCalendarMonths,
  getDonationEligibilityStatus,
  isValidDateOnly,
  isValidDonationDate
};