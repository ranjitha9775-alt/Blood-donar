"use strict";

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.headers || {}), ...(options.body ? { "Content-Type": "application/json" } : {}) }
  });
  const result = await response.json().catch(() => {
    throw new Error("The server returned an invalid response.");
  });
  if (!response.ok) throw new Error(result.message || "The request could not be completed.");
  return result;
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

const answerLabels = {
  feeling_well: "Feeling well today",
  recent_illness: "Recent illness or fever",
  taking_medication: "Currently taking medication",
  medication_name: "Medication name",
  receiving_treatment: "Receiving medical treatment",
  weight_kg: "Weight (kg)",
  blood_pressure_systolic_mmhg: "Systolic blood pressure (mmHg)",
  blood_pressure_diastolic_mmhg: "Diastolic blood pressure (mmHg)",
  health_conditions: "Health conditions / medical history",
  temporary_illness: "Temporary illness / other screening information",
  previously_deferred: "Previously deferred",
  last_donation_date: "Last donation date"
};

function renderScreening(screening) {
  const card = document.createElement("article");
  card.className = "screening";
  card.append(
    textElement("h2", `Screening ${screening.screening_id} · ${screening.full_name} · ${screening.blood_group}`),
    textElement("p", `Submitted ${new Date(screening.submitted_at).toLocaleString()}`, "muted")
  );
  const answers = document.createElement("div");
  answers.className = "answers";
  for (const [key, label] of Object.entries(answerLabels)) {
    const raw = screening.responses?.[key];
    const answer = raw === "yes" ? "Yes"
      : raw === "no" ? "No"
        : raw === "not_sure" ? "Not sure"
          : raw || "Not provided";
    answers.append(textElement("div", `${label}: ${answer}`, "answer"));
  }
  card.append(answers);
  const notesLabel = textElement("label", "Review note (optional, 500 characters max)");
  const notes = document.createElement("textarea");
  notes.maxLength = 500;
  notesLabel.append(notes);
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [reviewStatus, buttonText, className] of [
    ["Cleared", "Mark reviewed — cleared", ""],
    ["Not Cleared", "Mark not cleared", "not-cleared"]
  ]) {
    const button = textElement("button", buttonText, className);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await requestJson(`/api/blood-bank/health-screenings/${screening.screening_id}/review`, {
          method: "POST",
          body: JSON.stringify({ review_status: reviewStatus, review_notes: notes.value.trim() })
        });
        await loadScreenings();
      } catch (error) {
        document.getElementById("reviewMessage").textContent = error.message;
        button.disabled = false;
      }
    });
    actions.append(button);
  }
  card.append(notesLabel, actions);
  return card;
}

async function loadScreenings() {
  const container = document.getElementById("screenings");
  const message = document.getElementById("reviewMessage");
  try {
    const { screenings } = await requestJson("/api/blood-bank/health-screenings");
    container.replaceChildren(...screenings.map(renderScreening));
    message.textContent = screenings.length
      ? `${screenings.length} pending screening(s).`
      : "No pending donor screenings.";
  } catch (error) {
    console.error("Could not load blood-bank screenings:", error);
    message.textContent = error.message;
  }
}

async function loadEligibilityQueue() {
  const container = document.getElementById("eligibilityQueue");
  const message = document.getElementById("eligibilityMessage");
  try {
    const { donors } = await requestJson("/api/blood-bank/donors/eligibility");
    if (!donors.length) {
      container.replaceChildren(textElement("p", "No reviewed screenings awaiting a separate eligibility decision.", "muted"));
      message.textContent = "";
      return;
    }
    container.replaceChildren(...donors.map(donor => {
      const row = document.createElement("article");
      row.className = "request";
      row.append(
        textElement("strong", `${donor.full_name} · ${donor.blood_group}`),
        textElement("p", `Last donation: ${donor.last_donation_date || "None recorded"} · Interval date: ${donor.next_eligible_date || "Not set"} · Latest decision: ${donor.latest_decision || "None"}`, "status")
      );
      const notes = document.createElement("textarea");
      notes.maxLength = 500;
      notes.setAttribute("aria-label", "Eligibility review notes");
      const actions = document.createElement("div");
      actions.className = "actions";
      for (const [decision, label] of [["eligible", "Confirm eligible"], ["deferred", "Defer"]]) {
        const button = textElement("button", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await requestJson(`/api/blood-bank/donors/${donor.donor_user_id}/eligibility`, {
              method: "POST",
              body: JSON.stringify({ decision, notes: notes.value.trim() })
            });
            await loadEligibilityQueue();
          } catch (error) {
            message.textContent = error.message;
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      row.append(notes, actions);
      return row;
    }));
    message.textContent = `${donors.length} screening(s) ready for a professional decision.`;
  } catch (error) {
    message.textContent = error.message;
  }
}

async function loadInventory() {
  const rows = document.getElementById("inventoryRows");
  const audit = document.getElementById("inventoryAudit");
  try {
    const data = await requestJson("/api/blood-bank/inventory");
    document.getElementById("bankIdentity").textContent =
      `${data.bank.bank_name} · ${[data.bank.city, data.bank.district, data.bank.state].filter(Boolean).join(", ")}`;
    const confirmedUnits = data.inventory
      .filter(item => item.verification_status === "verified")
      .reduce((total, item) => total + Number(item.available_units || 0), 0);
    const latestUpdate = data.inventory
      .map(item => Date.parse(item.last_updated))
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), 0);
    document.getElementById("bankAvailableUnits").textContent = String(confirmedUnits);
    document.getElementById("bankStockGroups").textContent = String(data.inventory.length);
    document.getElementById("bankLastUpdated").textContent = latestUpdate
      ? new Date(latestUpdate).toLocaleString()
      : "No update yet";
    rows.replaceChildren(...(data.inventory.length ? data.inventory.map(item => {
      const row = document.createElement("tr");
      for (const value of [item.blood_group, item.component.replaceAll("_", " "),
        item.physical_units, item.reserved_units, item.issued_units, item.discarded_units,
        item.total_eligible_units, item.available_units,
        `${item.status} · ${item.verification_status}`,
        new Date(item.last_updated).toLocaleString()]) {
        row.append(textElement("td", String(value ?? "—")));
      }
      return row;
    }) : [(() => {
      const row = document.createElement("tr");
      const cell = textElement("td", "No daily stock records. Enter the verified physical count above.");
      cell.colSpan = 10;
      row.append(cell);
      return row;
    })()]));
    document.getElementById("stockAlerts").replaceChildren(...(data.alerts.length
      ? data.alerts.map(alert => textElement("p", alert.message, "status"))
      : [textElement("p", "No unresolved stock alerts. A fresh stock update is required for each UTC calendar day.", "muted")]));
    document.getElementById("stockHistory").replaceChildren(...(data.history.length
      ? data.history.map(item => textElement("p",
        `${item.blood_group} ${item.component.replaceAll("_", " ")} · Available ${item.previous_available_units} → ${item.available_units} · ${item.transaction_type} · ${item.staff_name} · ${new Date(item.created_at).toLocaleString()}${item.remarks ? ` · ${item.remarks}` : ""}`,
        "request"))
      : [textElement("p", "No stock updates recorded yet.", "muted")]));
    audit.replaceChildren(...(data.audit.length ? data.audit.map(item => textElement(
      "p",
      `${item.action} · Inventory ${item.inventory_id || "record removed"} · ${new Date(item.created_at).toLocaleString()}`,
      "status"
    )) : [textElement("p", "No inventory audit events yet.", "muted")]));
    const notificationContainer = document.getElementById("bankNotifications");
    notificationContainer.replaceChildren(...(data.notifications.length ? data.notifications.map(notification => {
      const item = document.createElement("article");
      item.className = "request";
      item.append(textElement("p", `Emergency request ${notification.request_id} · ${new Date(notification.created_at).toLocaleString()}`));
      const read = textElement("button", "Mark read");
      read.type = "button";
      read.addEventListener("click", async () => {
        try {
          await requestJson(`/api/blood-bank/notifications/${notification.notification_id}/read`, { method: "POST" });
          await loadInventory();
        } catch (error) {
          document.getElementById("inventoryMessage").textContent = error.message;
        }
      });
      item.append(read);
      return item;
    }) : [textElement("p", "No unread in-app notifications.", "muted")]));
  } catch (error) {
    document.getElementById("bankIdentity").textContent = error.message;
  }
}

async function saveInventory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("saveInventory");
  const message = document.getElementById("inventoryMessage");
  if (!form.reportValidity()) return;
  const quantities = [form.elements.physical_units.value, form.elements.reserved_units.value,
    form.elements.issued_units.value, form.elements.discarded_units.value].map(Number);
  if (quantities.some(value => !Number.isSafeInteger(value) || value < 0) ||
      quantities[1] + quantities[2] + quantities[3] > quantities[0]) {
    message.textContent = "Reserved, issued, and discarded units must be non-negative integers and cannot exceed physical stock.";
    return;
  }
  button.disabled = true;
  try {
    const result = await requestJson("/api/blood-stock/update", {
      method: "POST",
      body: JSON.stringify({
        blood_group: form.elements.inventoryGroup.value,
        component: form.elements.inventoryComponent.value,
        physical_units: quantities[0],
        reserved_units: quantities[1],
        issued_units: quantities[2],
        discarded_units: quantities[3],
        remarks: form.elements.remarks.value.trim(),
        idempotency_key: window.crypto.randomUUID(),
        transaction_type: "daily_update"
      })
    });
    message.textContent = `${result.message} Available: ${result.available_units} unit(s), ${result.status}. Updated ${new Date(result.last_updated).toLocaleString()}.`;
    await loadInventory();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadBankRequests() {
  const container = document.getElementById("bankRequests");
  const message = document.getElementById("bankRequestsMessage");
  try {
    const { requests } = await requestJson("/api/blood-bank/emergency-requests");
    if (!requests.length) {
      container.replaceChildren(textElement("p", "No active requests match this bank's assigned service area.", "muted"));
      return;
    }
    container.replaceChildren(...requests.map(request => {
      const row = document.createElement("article");
      row.className = "request";
      row.append(
        textElement("strong", `Request ${request.request_id} · ${request.blood_group} · ${request.component.replaceAll("_", " ")} · ${request.units} unit(s)`),
        textElement("p", `${request.hospital_name} · ${request.city}${request.district ? `, ${request.district}` : ""} · Needed ${new Date(request.needed_at).toLocaleString()}`, "status"),
        textElement("p", `Current coordinator status: ${request.coordination_status}.`, "status")
      );
      const actions = document.createElement("div");
      actions.className = "actions";
      const next = request.coordination_status === "Pending"
        ? [["Under Review", "Review"], ["Accepted", "Accept"], ["Rejected", "Reject"]]
        : request.coordination_status === "Under Review"
          ? [["Accepted", "Accept"], ["Rejected", "Reject"]]
        : request.coordination_status === "Accepted"
          ? [["In Progress", "Mark in progress"], ["Cancelled", "Cancel"]]
          : [["Fulfilled", "Mark fulfilled"], ["Cancelled", "Cancel"]];
      for (const [status, label] of next) {
        const button = textElement("button", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          if (status === "Fulfilled" && !window.confirm("Confirm that the blood request has actually been fulfilled?")) return;
          button.disabled = true;
          try {
            await requestJson(`/api/blood-bank/emergency-requests/${request.request_id}/status`, {
              method: "POST",
              body: JSON.stringify({ status, fulfillment_confirmed: status === "Fulfilled" })
            });
            await loadBankRequests();
          } catch (error) {
            message.textContent = error.message;
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      row.append(actions);
      return row;
    }));
    message.textContent = `${requests.length} active request(s) in this bank's service area.`;
  } catch (error) {
    message.textContent = error.message;
  }
}

async function initialize() {
  try {
    const { user } = await requestJson("/api/me");
    if (!user) {
      window.location.replace("/login");
      return;
    }
    if (user.role !== "blood_bank") {
      window.location.replace(user.role === "donor" ? "/donar-dashboard.html" : "/patient-dashboard.html");
      return;
    }
    document.getElementById("logout-button").hidden = false;
    document.getElementById("inventoryForm").addEventListener("submit", saveInventory);
    await Promise.all([loadScreenings(), loadEligibilityQueue(), loadInventory(), loadBankRequests()]);
    window.setInterval(loadEligibilityQueue, 30000);
    window.setInterval(loadBankRequests, 30000);
    window.setInterval(loadInventory, 60000);
  } catch (error) {
    document.getElementById("reviewMessage").textContent = error.message;
  }
}

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    if (response.ok) window.location.replace("/login");
    else document.getElementById("reviewMessage").textContent = "Logout failed. Please try again.";
  } catch (error) {
    document.getElementById("reviewMessage").textContent = error.message;
  }
});

initialize();
