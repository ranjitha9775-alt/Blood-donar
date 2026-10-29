"use strict";

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.headers || {}), ...(options.body ? { "Content-Type": "application/json" } : {}) }
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    const error = new Error(result.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function formatPortalTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  return cell;
}

function textRecord(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function loadStockPortal() {
  try {
    const data = await requestJson("/api/blood-bank/inventory");
    const bankLocation = [data.bank.address_text, data.bank.city, data.bank.district, data.bank.state]
      .filter(Boolean)
      .join(", ");
    const bankContact = [
      data.bank.phone ? `Phone: ${data.bank.phone}` : "",
      data.bank.email ? `Email: ${data.bank.email}` : "",
      data.bank.operating_hours ? `Hours: ${data.bank.operating_hours}` : ""
    ].filter(Boolean).join(" · ");
    document.getElementById("bankIdentity").textContent =
      `Bank #${data.bank.bank_id} · ${data.bank.bank_name}${bankLocation ? ` · ${bankLocation}` : ""}${bankContact ? ` · ${bankContact}` : ""}`;
    document.getElementById("portalMessage").textContent =
      `Authorized staff access · ${data.freshness_policy === "UTC calendar day" ? "Stock date uses UTC." : "Stock freshness is server-managed."}`;
    const inventoryRows = document.getElementById("inventoryRows");
    inventoryRows.replaceChildren();
    if (!data.inventory.length) {
      const row = document.createElement("tr");
      const cell = textCell("No stock records yet. Submit today's stock above.");
      cell.colSpan = 11;
      row.append(cell);
      inventoryRows.append(row);
    } else {
      data.inventory.forEach(item => {
        const row = document.createElement("tr");
        [
          item.blood_group,
          item.component.replaceAll("_", " "),
          item.stock_date,
          item.physical_units,
          item.reserved_units,
          item.issued_units,
          item.discarded_units,
          item.available_units,
          item.status,
          item.verification_status,
          formatPortalTime(item.last_updated)
        ].forEach(value => row.append(textCell(value)));
        inventoryRows.append(row);
      });
    }
    const history = document.getElementById("stockHistory");
    history.replaceChildren();
    if (!data.history.length) {
      history.textContent = "No stock updates have been recorded.";
    } else {
      data.history.forEach(item => {
        const record = document.createElement("p");
        record.textContent = `${item.blood_group} · ${item.component.replaceAll("_", " ")} · ${item.physical_units} physical unit(s) · ${item.previous_available_units} → ${item.available_units} available · ${item.transaction_type} · ${item.staff_name} · ${formatPortalTime(item.created_at)}${item.remarks ? ` · ${item.remarks}` : ""}`;
        history.append(record);
      });
    }
    const alerts = document.getElementById("bankStockAlerts");
    alerts.replaceChildren(...(data.alerts.length
      ? data.alerts.map(alert => textRecord(
        "p",
        `${alert.blood_group || "All groups"}${alert.component ? ` · ${alert.component.replaceAll("_", " ")}` : ""} · ${alert.alert_type}: ${alert.message} · Updated ${formatPortalTime(alert.last_triggered_at)}`,
        "record"
      ))
      : [textRecord("p", "No active stock alerts. Fresh, verified stock is still required for current public search.", "muted")]));
    renderBankNotifications(data.notifications);
    await loadBankRequests();
  } catch (error) {
    document.getElementById("portalMessage").textContent = error.message;
    if (error.status === 401) {
      window.location.replace("/login?next=%2Fblood-bank-portal.html");
    } else if (error.status === 403) {
      document.getElementById("portalMessage").textContent =
        "This staff account is not assigned to an active blood bank. Ask an authorized LifeDrop administrator to verify and map the account.";
    }
  }
}

function renderBankNotifications(notifications) {
  const container = document.getElementById("bankNotifications");
  container.replaceChildren();
  if (!notifications.length) {
    container.append(textRecord("p", "No unread emergency-request notifications.", "muted"));
    return;
  }
  notifications.forEach(notification => {
    const item = document.createElement("article");
    item.className = "record";
    item.append(textRecord(
      "p",
      `Emergency request ${notification.request_id} · ${notification.blood_group} ${notification.component.replaceAll("_", " ")} · ${notification.units} unit(s) · ${notification.city}${notification.district ? `, ${notification.district}` : ""} · ${formatPortalTime(notification.created_at)}`
    ));
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const view = textRecord("a", "View matching request");
    view.href = "#bankRequestsTitle";
    actions.append(view);
    const markRead = textRecord("button", "Mark as read", "button-secondary");
    markRead.type = "button";
    markRead.addEventListener("click", async () => {
      markRead.disabled = true;
      try {
        await requestJson(`/api/blood-bank/notifications/${encodeURIComponent(notification.notification_id)}/read`, {
          method: "POST"
        });
        await loadStockPortal();
      } catch (error) {
        document.getElementById("portalMessage").textContent = error.message;
        markRead.disabled = false;
      }
    });
    actions.append(markRead);
    item.append(actions);
    container.append(item);
  });
}

async function loadBankRequests() {
  const container = document.getElementById("bankRequests");
  const message = document.getElementById("bankRequestsMessage");
  try {
    const { requests } = await requestJson("/api/blood-bank/emergency-requests");
    if (!requests.length) {
      container.replaceChildren(textRecord("p", "No active requests match this bank's assigned service area.", "muted"));
      message.textContent = "";
      return;
    }
    container.replaceChildren(...requests.map(request => {
      const record = document.createElement("article");
      record.className = "record";
      record.append(
        textRecord("strong", `Request ${request.request_id} · ${request.blood_group} · ${request.component.replaceAll("_", " ")} · ${request.units} unit(s)`),
        textRecord("p", `${request.hospital_name} · ${request.city}${request.district ? `, ${request.district}` : ""} · Needed ${formatPortalTime(request.needed_at)}`),
        textRecord("p", `Contact: ${request.contact_name || "Not provided"} · ${request.contact_phone || "Not provided"}`),
        textRecord("p", `Coordination status: ${request.coordination_status}${request.is_escalated ? " · Escalated" : ""}`)
      );
      const nextStatuses = request.coordination_status === "Pending"
        ? [["Under Review", "Review"], ["Accepted", "Accept"], ["Rejected", "Reject"]]
        : request.coordination_status === "Under Review"
          ? [["Accepted", "Accept"], ["Rejected", "Reject"]]
          : request.coordination_status === "Accepted"
            ? [["In Progress", "Mark in progress"], ["Cancelled", "Cancel"]]
            : [["Fulfilled", "Mark fulfilled"], ["Cancelled", "Cancel"]];
      const actions = document.createElement("div");
      actions.className = "record-actions";
      nextStatuses.forEach(([status, label]) => {
        const action = textRecord("button", label);
        action.type = "button";
        if (status === "Rejected" || status === "Cancelled") action.className = "button-secondary";
        action.addEventListener("click", async () => {
          if (status === "Fulfilled" &&
              !window.confirm("Confirm this request has actually been fulfilled? This action will be recorded.")) return;
          action.disabled = true;
          message.textContent = `Updating request ${request.request_id}…`;
          try {
            const result = await requestJson(
              `/api/blood-bank/emergency-requests/${encodeURIComponent(request.request_id)}/status`,
              {
                method: "POST",
                body: JSON.stringify({ status, fulfillment_confirmed: status === "Fulfilled" })
              }
            );
            message.textContent = result.message;
            document.dispatchEvent(new Event("lifedrop:notifications-updated"));
            await loadBankRequests();
          } catch (error) {
            message.textContent = error.message;
            action.disabled = false;
          }
        });
        actions.append(action);
      });
      record.append(actions);
      return record;
    }));
    message.textContent = "";
  } catch (error) {
    console.error("Blood-bank emergency requests could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function submitDailyStock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("saveInventory");
  const message = document.getElementById("inventoryMessage");
  if (!form.reportValidity()) return;
  const quantities = [
    Number(form.elements.physical_units.value),
    Number(form.elements.reserved_units.value),
    Number(form.elements.issued_units.value),
    Number(form.elements.discarded_units.value)
  ];
  if (quantities.some(value => !Number.isSafeInteger(value) || value < 0) ||
      quantities[1] + quantities[2] + quantities[3] > quantities[0]) {
    message.textContent = "Stock values must be non-negative whole numbers, and reserved, issued, and discarded quantities cannot exceed physical stock.";
    return;
  }
  button.disabled = true;
  message.textContent = "Saving today's stock update…";
  try {
    const result = await requestJson("/api/blood-bank/inventory", {
      method: "POST",
      body: JSON.stringify({
        blood_group: form.elements.blood_group.value,
        component: form.elements.component.value,
        stock_date: form.elements.stock_date.value,
        physical_units: quantities[0],
        reserved_units: quantities[1],
        issued_units: quantities[2],
        discarded_units: quantities[3],
        remarks: form.elements.remarks.value.trim(),
        idempotency_key: window.crypto.randomUUID(),
        transaction_type: "daily_update"
      })
    });
    message.textContent = `${result.message} Stock date: ${result.stock_date || "server date unavailable"} (UTC) · Updated ${formatPortalTime(result.last_updated)} · ${result.available_units} available unit(s), pending verification.`;
    document.dispatchEvent(new Event("lifedrop:notifications-updated"));
    await loadStockPortal();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function initializeStockPortal() {
  try {
    const { user } = await requestJson("/api/me");
    if (!user) {
      window.location.replace("/login?next=%2Fblood-bank-portal.html");
      return;
    }
    if (user.role !== "blood_bank") {
      const destination = {
        donor: "/donar-dashboard.html",
        patient: "/patient-dashboard.html"
      }[user.role] || "/login";
      window.location.replace(destination);
      return;
    }
    if (window.LifeDropNotifications) window.LifeDropNotifications.start();
    document.getElementById("logout-button").hidden = false;
    const stockDate = document.getElementById("stockDate");
    const todayUtc = new Date().toISOString().slice(0, 10);
    stockDate.value = todayUtc;
    stockDate.min = todayUtc;
    stockDate.max = todayUtc;
    document.getElementById("inventoryForm").addEventListener("submit", submitDailyStock);
    document.getElementById("logout-button").addEventListener("click", async () => {
      try {
        const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        if (!response.ok) throw new Error("Logout failed. Please try again.");
        window.location.replace("/login");
      } catch (error) {
        document.getElementById("portalMessage").textContent = error.message;
      }
    });
    await loadStockPortal();
    window.setInterval(loadStockPortal, 60000);
    window.setInterval(loadBankRequests, 30000);
  } catch (error) {
    document.getElementById("portalMessage").textContent = error.message;
  }
}

initializeStockPortal();
