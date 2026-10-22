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

function formatDashboardDate(value) {
  if (!value) return "Not confirmed yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not confirmed yet" : date.toLocaleString();
}

function makeTextElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function loadDonorAvailability() {
  const message = document.getElementById("availabilityMessage");
  try {
    const data = await requestJson("/api/availability/status");
    const status = document.getElementById("availabilityStatus");
    status.textContent = data.status;
    status.className = `status-label ${
      data.status === "Available" ? "available"
        : data.status === "Not Available" ? "not-available"
          : "needs-confirmation"
    }`;
    document.getElementById("lastConfirmedAt").textContent =
      formatDashboardDate(data.last_confirmed_at);
    document.querySelectorAll('input[name="status"]').forEach(option => {
      option.checked = option.value === data.availability_status;
    });
    document.getElementById("publicContactConsent").checked = data.public_contact_consent;
    document.getElementById("emergencyResponseConsent").checked = data.emergency_response_consent;
    message.textContent = data.available_until
      ? `This confirmation expires ${formatDashboardDate(data.available_until)}.`
      : "";
  } catch (error) {
    console.error("Donor availability could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function loadDonorEmergencyRequests() {
  const container = document.getElementById("emergencyRequests");
  const message = document.getElementById("emergencyRequestsMessage");
  try {
    const { requests, unread_count: unreadCount } = await requestJson("/api/donor/notifications");
    document.getElementById("unreadNotificationCount").textContent = `${unreadCount} unread`;
    document.getElementById("unreadNotificationCount").hidden = unreadCount === 0;
    if (!requests.length) {
      container.replaceChildren(makeTextElement("p", "No matching emergency requests.", "muted"));
      message.textContent = "";
      return;
    }
    const cards = requests.map(request => {
      const card = document.createElement("article");
      card.className = "request";
      const summary = makeTextElement(
        "p",
        `Request ${request.request_id} · ${request.blood_group} · ${request.units} unit(s) · ${request.city}${request.district ? `, ${request.district}` : ""}.`
      );
      const notificationStatus = makeTextElement(
        "p",
        `Notification: ${request.response_status}.${request.read_at ? "" : " New notification."}`,
        request.read_at ? "muted" : "notification-unread"
      );
      card.append(makeTextElement("strong", "LifeDrop: Emergency Blood Request"), summary, notificationStatus);
      const viewButton = makeTextElement("button", "View Request");
      viewButton.type = "button";
      viewButton.className = "button-secondary";
      const details = document.createElement("div");
      details.className = "request-details";
      details.hidden = true;
      details.append(
        makeTextElement("p", `Request ID: ${request.request_id}`),
        makeTextElement("p", `Blood group needed: ${request.blood_group} · ${request.units} unit(s)`),
        makeTextElement("p", `Hospital: ${request.hospital_name || "Not provided"}`),
        makeTextElement("p", `Approximate location: ${request.city}${request.district ? `, ${request.district}` : ""}`),
        makeTextElement("p", `Urgency: ${request.urgency} · Requested: ${formatDashboardDate(request.requested_at)}`),
        makeTextElement("p", `Needed by: ${formatDashboardDate(request.needed_at)} · Response deadline: ${formatDashboardDate(request.response_deadline)}`),
        makeTextElement("p", `Your current availability: ${request.donor_availability_status}.`),
        makeTextElement("p", `Your response: ${request.response_status}. A response does not guarantee attendance or donation.`)
      );
      if (request.response_status === "Response Pending") {
        const contactConsent = document.createElement("label");
        contactConsent.className = "consent";
        const contactCheckbox = document.createElement("input");
        contactCheckbox.type = "checkbox";
        contactCheckbox.className = "share-contact";
        const contactText = document.createElement("span");
        contactText.textContent = "If I select Available, I consent to sharing my name and phone number with this patient so we can coordinate.";
        contactConsent.append(contactCheckbox, contactText);
        details.append(contactConsent);
        const actions = document.createElement("div");
        actions.className = "request-actions";
        const canHelp = makeTextElement("button", "Available");
        const cannotHelp = makeTextElement("button", "Not available");
        canHelp.type = "button";
        cannotHelp.type = "button";
        canHelp.disabled = request.can_offer_help !== 1;
        if (canHelp.disabled) {
          details.append(makeTextElement("p", "Confirm current availability and opt into emergency matching to respond Available."));
        }
        canHelp.addEventListener("click", () => respondToEmergencyRequest(
          request.request_id, "can_help", contactCheckbox.checked, actions
        ));
        cannotHelp.addEventListener("click", () => respondToEmergencyRequest(
          request.request_id, "cannot_help", false, actions
        ));
        actions.append(canHelp, cannotHelp);
        details.append(actions);
      }
      viewButton.addEventListener("click", async () => {
        details.hidden = !details.hidden;
        viewButton.textContent = details.hidden ? "View Request" : "Hide Request";
        if (!details.hidden && !request.read_at) {
          try {
            await requestJson(`/api/donor/notifications/${encodeURIComponent(request.request_id)}/read`, {
              method: "POST"
            });
            request.read_at = new Date().toISOString();
            notificationStatus.textContent = `Notification: ${request.response_status}.`;
            notificationStatus.className = "muted";
            const unreadBadge = document.getElementById("unreadNotificationCount");
            const currentUnread = Number.parseInt(unreadBadge.textContent, 10) || 0;
            unreadBadge.textContent = `${Math.max(0, currentUnread - 1)} unread`;
            unreadBadge.hidden = currentUnread <= 1;
          } catch (error) {
            console.error("Notification could not be marked as read:", error);
            message.textContent = error.message;
          }
        }
      });
      card.append(viewButton, details);
      return card;
    });
    container.replaceChildren(...cards);
    message.textContent = "";
  } catch (error) {
    console.error("Matched emergency requests could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function respondToEmergencyRequest(requestId, response, shareContact, actions) {
  const message = document.getElementById("emergencyRequestsMessage");
  const actionLabel = response === "can_help" ? "Available" : "Not available";
  const contactNotice = shareContact
    ? " Your name and phone number will be shared with the patient."
    : " Your contact details will remain private.";
  if (!window.confirm(`Confirm you are ${actionLabel} for this request?${contactNotice} This does not guarantee attendance or donation.`)) {
    return;
  }
  actions.querySelectorAll("button").forEach(button => { button.disabled = true; });
  message.textContent = "Saving your response…";
  try {
    const result = await requestJson(
      `/api/donor/emergency-requests/${encodeURIComponent(requestId)}/response`,
      { method: "POST", body: JSON.stringify({ response, share_contact: shareContact }) }
    );
    message.textContent = result.message;
    await loadDonorEmergencyRequests();
  } catch (error) {
    console.error("Emergency request response could not be saved:", error);
    message.textContent = error.message;
    await loadDonorEmergencyRequests();
  }
}

async function loadPatientResponses() {
  const container = document.getElementById("patientResponses");
  const message = document.getElementById("patientResponsesMessage");
  try {
    const { requests } = await requestJson("/api/my-emergency-responses");
    if (!requests.length) {
      container.replaceChildren(makeTextElement("p", "No matching donor responses yet.", "muted"));
      message.textContent = "";
      return;
    }
    const cards = requests.map(request => {
      const card = document.createElement("article");
      card.className = "response";
      card.append(
        makeTextElement("strong", `Request ${request.request_id} · ${request.blood_group} · ${request.units} unit(s) · ${request.city}${request.district ? `, ${request.district}` : ""}`),
        makeTextElement("p", `Status: ${request.status}. Needed by ${formatDashboardDate(request.needed_at)}.`),
        makeTextElement("p", `Responses: ${request.counts.can_help} donor(s) can help, ${request.counts.cannot_help} cannot help, ${request.counts.pending} waiting, ${request.counts.no_response} no response.`)
      );
      request.donor_responses.forEach(donorResponse => {
        const responseLine = document.createElement("div");
        responseLine.append(makeTextElement("p", donorResponse.status));
        if (donorResponse.availability_status) {
          responseLine.append(makeTextElement(
            "p",
            `Donor availability: ${donorResponse.availability_status}. Last confirmed: ${
              formatDashboardDate(donorResponse.last_confirmed_at)
            }.`
          ));
        }
        if (donorResponse.donor_name && donorResponse.donor_phone) {
          responseLine.append(makeTextElement(
            "p",
            `This donor consented to contact sharing: ${donorResponse.donor_name} · ${donorResponse.donor_phone}`
          ));
        }
        card.append(responseLine);
      });
      return card;
    });
    container.replaceChildren(...cards);
    message.textContent = "";
  } catch (error) {
    console.error("Emergency donor responses could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function loadDashboard() {
  const welcome = document.getElementById("welcome");
  const logoutButton = document.getElementById("logout-button");
  try {
    const result = await requestJson("/api/me");
    const user = result.user;
    if (!user) {
      window.location.replace("/login");
      return;
    }
    const isPatientDashboard = window.location.pathname.includes("patient-dashboard");
    const expectedRole = isPatientDashboard ? "patient" : "donor";
    if (user.role !== expectedRole) {
      window.location.replace(user.role === "donor" ? "/donar-dashboard.html" : "/patient-dashboard.html");
      return;
    }
    welcome.textContent = `Welcome, ${user.full_name}.`;
    logoutButton.hidden = false;

    if (user.role === "donor") {
      await loadDonorAvailability();
      document.getElementById("availabilityCard").hidden = false;
      document.getElementById("emergencyRequestsCard").hidden = false;
      await loadDonorEmergencyRequests();
      window.setInterval(loadDonorAvailability, 15000);
      window.setInterval(loadDonorEmergencyRequests, 30000);
    } else {
      document.getElementById("patientResponsesCard").hidden = false;
      await loadPatientResponses();
      window.setInterval(loadPatientResponses, 30000);
    }
  } catch (error) {
    console.error("Dashboard login verification failed:", error);
    welcome.textContent = error.status === 401
      ? "Please log in to view your dashboard."
      : `Could not verify your login: ${error.message}`;
  }
}

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    if (response.ok) {
      window.location.replace("/login");
    } else {
      alert("Logout failed. Please try again.");
    }
  } catch (error) {
    console.error("Logout failed:", error);
    alert("Could not connect to the server.");
  }
});

const availabilityForm = document.getElementById("availabilityForm");
if (availabilityForm) {
  availabilityForm.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("confirmAvailability");
    const message = document.getElementById("availabilityMessage");
    const status = new FormData(form).get("status");
    if (!status) {
      message.textContent = "Choose Available to Donate or Not Available.";
      return;
    }
    button.disabled = true;
    message.textContent = "Saving your confirmation…";
    try {
      const result = await requestJson("/api/availability/status", {
        method: "POST",
        body: JSON.stringify({
          status,
          public_contact_consent: document.getElementById("publicContactConsent").checked,
          emergency_response_consent: document.getElementById("emergencyResponseConsent").checked
        })
      });
      await loadDonorAvailability();
      await loadDonorEmergencyRequests();
      message.textContent = result.status === "Available"
        ? `Your confirmation was saved until ${formatDashboardDate(result.available_until)}.`
        : "Your status was saved as Not Available.";
    } catch (error) {
      console.error("Donor availability could not be saved:", error);
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

loadDashboard();
