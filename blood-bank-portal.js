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

async function loadStockPortal() {
  try {
    const data = await requestJson("/api/blood-bank/inventory");
    document.getElementById("bankIdentity").textContent =
      `Bank #${data.bank.bank_id} · ${data.bank.bank_name} · ${[data.bank.city, data.bank.district, data.bank.state].filter(Boolean).join(", ")}`;
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
  } catch (error) {
    document.getElementById("portalMessage").textContent = error.message;
  }
}

initializeStockPortal();
