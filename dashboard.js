"use strict";

let dashboardUser = null;

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
    document.getElementById("availableToDonate").setAttribute(
      "aria-pressed",
      String(data.status === "Available")
    );
    document.getElementById("notAvailable").setAttribute(
      "aria-pressed",
      String(data.status === "Not Available")
    );
    document.getElementById("publicContactConsent").checked = data.public_contact_consent;
    document.getElementById("emergencyResponseConsent").checked = data.emergency_response_consent;
    message.textContent = data.available_until
      ? `Confirmation expiry: ${formatDashboardDate(data.available_until)}.`
      : data.last_confirmed_at
        ? "You are not currently listed as available."
        : "You have not confirmed availability yet.";
  } catch (error) {
    console.error("Donor availability could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function saveDonorAvailability(status) {
  const buttons = [
    document.getElementById("availableToDonate"),
    document.getElementById("notAvailable")
  ];
  const message = document.getElementById("availabilityMessage");
  buttons.forEach(button => { button.disabled = true; });
  message.textContent = "Saving your availability…";
  try {
    const result = await requestJson("/api/availability/status", {
      method: "POST",
      body: JSON.stringify({
        status,
        public_contact_consent: document.getElementById("publicContactConsent").checked,
        emergency_response_consent: document.getElementById("emergencyResponseConsent").checked,
        expires_in_hours: Number(document.getElementById("availabilityExpiry").value)
      })
    });
    await loadDonorAvailability();
    await loadDonorEmergencyRequests();
    try {
      localStorage.setItem("lifedrop-availability-updated", String(Date.now()));
    } catch (error) {
      console.warn("Could not signal the open admin dashboard to refresh:", error);
    }
    message.textContent = result.status === "Available"
      ? `Your availability was saved until ${formatDashboardDate(result.available_until)}.`
      : "Your status was saved as Not Available.";
  } catch (error) {
    console.error("Donor availability could not be saved:", error);
    message.textContent = error.message;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
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
      if (request.response_status === "Pending") {
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

async function searchPatientDonors(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("searchDonorsButton");
  const message = document.getElementById("donorSearchMessage");
  const results = document.getElementById("donorSearchResults");
  if (!form.reportValidity()) return;
  button.disabled = true;
  results.replaceChildren();
  message.textContent = "Searching current donor confirmations…";
  const params = new URLSearchParams({
    state: "Karnataka",
    city: document.getElementById("searchCity").value.trim(),
    blood_group: document.getElementById("searchBloodGroup").value,
    radius_km: document.getElementById("searchRadius").value,
    units: document.getElementById("searchUnits").value,
    emergency: String(document.getElementById("searchEmergency").checked)
  });
  try {
    const data = await requestJson(`/api/donors/search?${params}`);
    if (!data.donors.length) {
      message.textContent = "No currently confirmed donors found.";
      const empty = makeTextElement(
        "p",
        "Try a wider Karnataka search or check reported blood-bank stock. Donor availability is self-reported and may change."
      );
      const widerSearch = makeTextElement("button", "Search wider area");
      widerSearch.type = "button";
      widerSearch.className = "button-secondary";
      widerSearch.addEventListener("click", () => {
        document.getElementById("searchRadius").value = "wider";
        form.requestSubmit();
      });
      results.append(empty, widerSearch);
      return;
    }
    message.textContent =
      `${data.donors.length} currently confirmed match(es) · Checked ${formatDashboardDate(data.checked_at)}. ${data.location_precision}`;
    const cards = data.donors.map((donor, index) => {
      const card = document.createElement("article");
      card.className = "search-result";
      card.append(
        makeTextElement("strong", `${donor.display_name} ${index + 1} · ${donor.blood_group}`),
        makeTextElement("p", `${donor.city}, ${donor.state} · ${donor.availability_status}`),
        makeTextElement("p", "Approximate location; distance is not available because donor coordinates are not stored."),
        makeTextElement("p", `Last confirmed: ${formatDashboardDate(donor.last_confirmed_at)} · Available until: ${formatDashboardDate(donor.available_until)}.`)
      );
      if (document.getElementById("searchEmergency").checked) {
        card.append(makeTextElement(
          "p",
          donor.emergency_matching_enabled
            ? "This donor opted into in-app emergency matching."
            : "This donor is not opted into emergency notifications."
        ));
      }
      const action = makeTextElement("button", "Request Help");
      action.type = "button";
      action.addEventListener("click", () => {
        document.getElementById("patientRequestCard").hidden = false;
        document.getElementById("requestBlood").value = donor.blood_group;
        document.getElementById("requestCity").value = donor.city;
        document.getElementById("requestDistrict").value = donor.city;
        document.getElementById("requestUnits").value = document.getElementById("searchUnits").value;
        document.getElementById("requestUrgency").value = "Urgent";
        document.getElementById("requestMatchDonors").checked = true;
        document.getElementById("patientRequestCard").scrollIntoView({ behavior: "smooth" });
        document.getElementById("requestHospitalName").focus();
      });
      card.append(action);
      return card;
    });
    results.replaceChildren(...cards);
  } catch (error) {
    console.error("Patient donor search failed:", error);
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function submitPatientEmergencyRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("sendEmergencyRequestButton");
  const message = document.getElementById("patientRequestMessage");
  if (!form.reportValidity()) return;
  const neededAt = new Date(form.elements.needed_at.value);
  if (!Number.isFinite(neededAt.getTime()) || neededAt.getTime() <= Date.now()) {
    message.textContent = "Choose a future date and time, or contact the hospital immediately for urgent needs.";
    return;
  }
  button.disabled = true;
  message.textContent = "Saving the request and matching opted-in donors…";
  try {
    const result = await requestJson("/api/blood-requests", {
      method: "POST",
      body: JSON.stringify({
        patient: dashboardUser.full_name,
        blood: document.getElementById("requestBlood").value,
        units: Number(form.elements.units.value),
        urgency: form.elements.urgency.value,
        hospital_name: form.elements.hospital_name.value.trim(),
        hospital_address: form.elements.hospital_address.value.trim(),
        city: form.elements.city.value.trim(),
        state: "Karnataka",
        district: form.elements.district.value.trim(),
        needed_at: neededAt.toISOString(),
        consent: form.elements.consent.checked,
        match_donors: form.elements.match_donors.checked
      })
    });
    message.textContent = result.matched_donor_count
      ? `${result.message} ${result.matched_donor_count} matching donor notification(s) were saved.`
      : `${result.message} No opted-in donors matched this exact blood group and city.`;
    await loadPatientResponses();
  } catch (error) {
    console.error("Patient emergency request could not be saved:", error);
    message.textContent = error.message;
  } finally {
    button.disabled = false;
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
    dashboardUser = user;
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
      document.getElementById("searchCity").value = user.city || "Mysuru";
      document.getElementById("requestCity").value = user.city || "Mysuru";
      document.getElementById("requestDistrict").value = user.city || "Mysuru";
      const defaultNeededAt = new Date(Date.now() + 60 * 60 * 1000);
      defaultNeededAt.setMinutes(defaultNeededAt.getMinutes() - defaultNeededAt.getTimezoneOffset());
      document.getElementById("requestNeededAt").value = defaultNeededAt.toISOString().slice(0, 16);
      document.getElementById("requestBlood").value = document.getElementById("searchBloodGroup").value;
      document.getElementById("searchBloodGroup").addEventListener("change", event => {
        document.getElementById("requestBlood").value = event.currentTarget.value;
      });
      document.getElementById("searchUnits").addEventListener("input", event => {
        document.getElementById("requestUnits").value = event.currentTarget.value;
      });
      document.getElementById("patientDonorSearchForm").addEventListener("submit", searchPatientDonors);
      document.getElementById("patientEmergencyRequestForm").addEventListener("submit", submitPatientEmergencyRequest);
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

document.getElementById("availableToDonate")?.addEventListener("click", () => {
  saveDonorAvailability("available");
});

document.getElementById("notAvailable")?.addEventListener("click", () => {
  saveDonorAvailability("not_available");
});

loadDashboard();
