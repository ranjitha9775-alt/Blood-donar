"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNotificationPayload,
  getAvailabilityNotificationCopy,
  getUnreadNotificationCount,
  isNotificationRecipient,
  markNotificationAsRead,
  isValidNotificationId
} = require("./notification-utils");

test("availability confirmation messages reflect donor matching eligibility", () => {
  assert.match(getAvailabilityNotificationCopy("available", true).message, /current confirmation/);
  assert.match(getAvailabilityNotificationCopy("available", false).message, /not currently eligible/);
  assert.match(getAvailabilityNotificationCopy("not_available", true).message, /will not appear/);
  assert.equal(getAvailabilityNotificationCopy("unknown", false), null);
});

test("creates validated, deduplicatable notification records without private details", () => {
  assert.deepEqual(createNotificationPayload({
    recipientUserId: 14,
    title: "Blood request updated",
    message: "An authorized staff member updated your request status.",
    type: "request_status",
    relatedRequestId: 92,
    dedupeKey: "request-status:92:accepted"
  }), {
    recipient_user_id: 14,
    recipient_admin_id: null,
    title: "Blood request updated",
    message: "An authorized staff member updated your request status.",
    notification_type: "request_status",
    related_request_id: 92,
    dedupe_key: "request-status:92:accepted"
  });
  assert.equal(createNotificationPayload({
    recipientUserId: 14,
    recipientAdminId: 1,
    title: "Invalid",
    message: "Invalid",
    type: "invalid",
    dedupeKey: "invalid"
  }), null);
  assert.equal(createNotificationPayload({
    recipientUserId: 14,
    title: "Invalid",
    message: "",
    type: "invalid",
    dedupeKey: "invalid"
  }), null);
});

test("restricts notification access to its intended user or admin", () => {
  const notification = { recipient_user_id: 14, recipient_admin_id: null };
  const adminNotification = { recipient_user_id: null, recipient_admin_id: 1 };
  assert.equal(isNotificationRecipient(notification, { userId: 14 }), true);
  assert.equal(isNotificationRecipient(notification, { userId: 15 }), false);
  assert.equal(isNotificationRecipient(adminNotification, { adminId: 1 }), true);
  assert.equal(isNotificationRecipient(adminNotification, { adminId: 2 }), false);
  assert.equal(isNotificationRecipient(adminNotification, { userId: 1 }), false);
});

test("counts unread records and validates notification IDs", () => {
  assert.equal(getUnreadNotificationCount([
    { read_at: null },
    { read_at: "2026-10-26T10:00:00Z" },
    { read_at: null }
  ]), 2);
  assert.equal(isValidNotificationId("123"), true);
  assert.equal(isValidNotificationId("0"), false);
  assert.equal(isValidNotificationId("1 OR 1=1"), false);
  assert.equal(isValidNotificationId(1), false);
});

test("marks only the owning account's notification as read", () => {
  const notification = { notification_id: 8, recipient_user_id: 14, read_at: null };
  assert.deepEqual(markNotificationAsRead(notification, { userId: 14 }, "2026-10-26T07:00:00Z"), {
    notification_id: 8,
    recipient_user_id: 14,
    read_at: "2026-10-26T07:00:00Z"
  });
  assert.equal(markNotificationAsRead(notification, { userId: 15 }, "2026-10-26T07:00:00Z"), null);
  assert.equal(markNotificationAsRead({
    ...notification,
    read_at: "2026-10-26T06:00:00Z"
  }, { userId: 14 }, "2026-10-26T07:00:00Z").read_at, "2026-10-26T06:00:00Z");
});
