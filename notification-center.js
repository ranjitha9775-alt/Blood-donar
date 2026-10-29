"use strict";

(() => {
  const role = document.body.dataset.notificationRole;
  const nav = document.querySelector("header .nav");
  if (!["donor", "patient", "admin", "blood_bank"].includes(role) || !nav) return;

  const isAdmin = role === "admin";
  const apiBase = isAdmin ? "/api/admin/notifications" : "/api/notifications";
  const widget = document.createElement("div");
  widget.className = "notification-widget";
  widget.hidden = true;

  const toggle = document.createElement("button");
  toggle.className = "notification-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open notifications");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const bell = document.createElementNS("http://www.w3.org/2000/svg", "path");
  bell.setAttribute("d", "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4");
  bell.setAttribute("fill", "none");
  bell.setAttribute("stroke", "currentColor");
  bell.setAttribute("stroke-width", "2");
  bell.setAttribute("stroke-linecap", "round");
  bell.setAttribute("stroke-linejoin", "round");
  icon.append(bell);
  toggle.append(icon);
  const toggleLabel = document.createElement("span");
  toggleLabel.className = "notification-toggle-label";
  toggleLabel.textContent = "Notifications";
  toggle.append(toggleLabel);
  const count = document.createElement("span");
  count.className = "notification-count";
  count.hidden = true;
  count.textContent = "0";
  toggle.append(count);

  const panel = document.createElement("section");
  panel.className = "notification-panel";
  panel.setAttribute("aria-label", "Notifications");
  panel.hidden = true;
  const panelHeader = document.createElement("div");
  panelHeader.className = "notification-panel-header";
  const heading = document.createElement("h2");
  heading.textContent = "Notifications";
  const close = document.createElement("button");
  close.className = "notification-mark-read";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => setOpen(false));
  panelHeader.append(heading, close);
  const listMessage = document.createElement("p");
  listMessage.className = "notification-panel-message";
  listMessage.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.setAttribute("aria-live", "polite");
  panel.append(panelHeader, listMessage, list);
  widget.append(toggle, panel);
  nav.insertBefore(widget, nav.lastElementChild);

  let started = false;
  let refreshTimer = null;
  let currentNotifications = [];
  let unreadCount = 0;

  async function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const refreshed = await refreshNotifications();
    if (!refreshed) return;
    if (unreadCount === 0) return;
    try {
      await requestJson(`${apiBase}/read-all`, { method: "POST", body: "{}" });
      const readAt = new Date().toISOString();
      currentNotifications.forEach(notification => {
        if (!notification.read_at) notification.read_at = readAt;
      });
      renderNotifications(currentNotifications, 0);
    } catch (error) {
      listMessage.textContent = error.message;
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
  }

  function renderNotifications(notifications, totalUnread = null) {
    currentNotifications = notifications;
    unreadCount = totalUnread === null
      ? notifications.filter(item => !item.read_at).length
      : totalUnread;
    count.textContent = unreadCount > 99
      ? "99+"
      : String(unreadCount);
    count.hidden = unreadCount === 0;
    toggle.setAttribute("aria-label", `Notifications, ${unreadCount} unread`);
    list.replaceChildren();
    if (!notifications.length) {
      list.append(Object.assign(document.createElement("p"), {
        className: "notification-panel-message",
        textContent: "You have no notifications."
      }));
      return;
    }

    notifications.forEach(notification => {
      const item = document.createElement("article");
      item.className = `notification-item${notification.read_at ? "" : " unread"}`;
      const title = document.createElement("h3");
      title.textContent = notification.title;
      const message = document.createElement("p");
      message.textContent = notification.message;
      const time = document.createElement("time");
      time.dateTime = notification.created_at;
      time.textContent = formatDate(notification.created_at);
      const state = document.createElement("span");
      state.className = "notification-state";
      state.textContent = notification.read_at ? " · Read" : " · Unread";
      time.append(state);
      item.append(title, message, time);
      const actionByType = {
        availability_confirmation_required: ["/donor-dashboard.html#availabilityCard", "Confirm availability"],
        availability_reconfirmation: ["/donor-dashboard.html#availabilityCard", "Reconfirm availability"],
        eligibility_review_approaching: ["/donor-eligibility.html", "Review eligibility"],
        eligibility_review_due: ["/donor-eligibility.html", "Review eligibility"],
        emergency_request: ["/donor-dashboard.html#emergencyRequestsCard", "View request"],
        donor_response: ["/patient-dashboard.html#patientResponsesCard", "Review donor responses"],
        request_status: ["/patient-dashboard.html#patientRequestStatusCard", "Review request status"],
        admin_request: ["/admin#patientManagementTitle", "Review emergency requests"],
        admin_request_status: ["/admin#patientManagementTitle", "Review request status"],
        admin_donor_response: ["/admin#patientManagementTitle", "Review donor response"],
        notification_failure: ["/admin#patientManagementTitle", "Review system notification"],
        patient_selected_donor: ["/donor-dashboard.html#emergencyRequestsCard", "View patient selection"],
        blood_stock_update_due: ["/blood-bank-portal.html", "Update blood stock"]
      };
      const action = actionByType[notification.notification_type];
      if (action) {
        const link = document.createElement("a");
        link.className = "notification-action";
        link.href = action[0];
        link.textContent = action[1];
        item.append(link);
      }
      if (!notification.read_at) {
        const markRead = document.createElement("button");
        markRead.className = "notification-mark-read";
        markRead.type = "button";
        markRead.textContent = "Mark as read";
        markRead.addEventListener("click", () => markNotificationRead(notification, markRead));
        item.append(markRead);
      }
      list.append(item);
    });
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("The server returned an invalid notification response.");
    }
    if (!response.ok) {
      const error = new Error(data.message || "Could not load notifications.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function refreshNotifications() {
    widget.hidden = false;
    try {
      const data = await requestJson(apiBase);
      listMessage.textContent = "";
      renderNotifications(data.notifications, Number(data.unread_count));
      return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        window.LifeDropNotifications.stop();
        return false;
      }
      listMessage.textContent = error.message;
      list.replaceChildren(Object.assign(document.createElement("p"), {
        className: "notification-panel-message",
        textContent: "Notifications could not be loaded. Your saved availability is managed separately; try again shortly."
      }));
      return false;
    }
  }

  async function markNotificationRead(notification, button) {
    button.disabled = true;
    try {
      await requestJson(`${apiBase}/${encodeURIComponent(notification.notification_id)}/read`, {
        method: "POST",
        body: "{}"
      });
      if (!notification.read_at) unreadCount = Math.max(0, unreadCount - 1);
      notification.read_at = new Date().toISOString();
      renderNotifications(currentNotifications, unreadCount);
    } catch (error) {
      listMessage.textContent = error.message;
      button.disabled = false;
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("click", event => {
    if (!widget.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") setOpen(false);
  });
  document.addEventListener("lifedrop:notifications-updated", refreshNotifications);
  window.addEventListener("storage", event => {
    if (event.key === "lifedrop-notifications-updated") refreshNotifications();
  });

  window.LifeDropNotifications = {
    start() {
      if (started) return;
      started = true;
      refreshNotifications();
      refreshTimer = window.setInterval(refreshNotifications, 30000);
    },
    refresh: refreshNotifications,
    stop() {
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
      refreshTimer = null;
      started = false;
      widget.hidden = true;
      setOpen(false);
    }
  };
})();
