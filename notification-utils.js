"use strict";

function isValidNotificationId(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}

function isNotificationRecipient(notification, recipient) {
  if (recipient.adminId !== undefined && recipient.adminId !== null) {
    return String(notification.recipient_admin_id) === String(recipient.adminId);
  }
  return recipient.userId !== undefined && recipient.userId !== null &&
    String(notification.recipient_user_id) === String(recipient.userId);
}

function getUnreadNotificationCount(notifications) {
  return notifications.filter(notification => notification.read_at === null).length;
}

function markNotificationAsRead(notification, recipient, readAt) {
  if (!isNotificationRecipient(notification, recipient)) return null;
  return { ...notification, read_at: notification.read_at || readAt };
}

function createNotificationPayload({
  recipientUserId = null,
  recipientAdminId = null,
  title,
  message,
  type,
  relatedRequestId = null,
  dedupeKey
}) {
  const hasUser = Number.isSafeInteger(Number(recipientUserId)) && Number(recipientUserId) > 0;
  const hasAdmin = Number.isSafeInteger(Number(recipientAdminId)) && Number(recipientAdminId) > 0;
  if (hasUser === hasAdmin || typeof title !== "string" || !title.trim() ||
      title.length > 120 || typeof message !== "string" || !message.trim() ||
      message.length > 500 || typeof type !== "string" || !type.trim() ||
      type.length > 40 || typeof dedupeKey !== "string" || !dedupeKey.trim() ||
      dedupeKey.length > 160 ||
      (relatedRequestId !== null &&
        (!Number.isSafeInteger(Number(relatedRequestId)) || Number(relatedRequestId) < 1))) {
    return null;
  }
  return {
    recipient_user_id: hasUser ? Number(recipientUserId) : null,
    recipient_admin_id: hasAdmin ? Number(recipientAdminId) : null,
    title: title.trim(),
    message: message.trim(),
    notification_type: type.trim(),
    related_request_id: relatedRequestId === null ? null : Number(relatedRequestId),
    dedupe_key: dedupeKey
  };
}

module.exports = {
  createNotificationPayload,
  getUnreadNotificationCount,
  markNotificationAsRead,
  isNotificationRecipient,
  isValidNotificationId
};
