"use strict";

let dashboardUser = null;
let selectedAvailabilityDates = [];

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

function renderAvailabilityDates() {
  const container = document.getElementById("availabilityDateList");
  const mode = document.getElementById("availabilityMode");
  const useSelectedDates = mode.value === "selected_dates";
  document.getElementById("selectedDateControls").hidden = !useSelectedDates;
  document.getElementById("availabilityExpiryField").hidden = useSelectedDates;
  if (!container) return;
  const dateInput = document.getElementById("availabilityDate");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  dateInput.min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  if (!selectedAvailabilityDates.length) {
    container.replaceChildren(makeTextElement("p", "No future dates saved.", "muted"));
    return;
  }
  const rows = selectedAvailabilityDates
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(item => {
      const row = document.createElement("div");
      row.className = "request";
      const label = makeTextElement("span", `${item.date} · ${item.status === "available" ? "Available" : "Not available"}`);
      const toggle = makeTextElement("button",
        item.status === "available" ? "Mark unavailable" : "Mark available");
      toggle.type = "button";
      toggle.className = "button-secondary";
      toggle.addEventListener("click", () => {
        item.status = item.status === "available" ? "unavailable" : "available";
        renderAvailabilityDates();
      });
      const remove = makeTextElement("button", "Remove date");
      remove.type = "button";
      remove.className = "button-secondary";
      remove.addEventListener("click", () => {
        selectedAvailabilityDates = selectedAvailabilityDates.filter(date => date.date !== item.date);
        renderAvailabilityDates();
      });
      row.append(label, toggle, remove);
      return row;
    });
  container.replaceChildren(...rows);
}

async function loadDonorAvailability() {
  const message = document.getElementById("availabilityMessage");
  try {
    const data = await requestJson("/api/availability/status");
    const status = document.getElementById("availabilityStatus");
    const displayedStatus = data.status === "Available" && !data.eligible_for_matching
      ? "Confirmed · Not matchable"
      : data.status;
    status.textContent = displayedStatus;
    status.className = `status-label ${
      displayedStatus === "Available" ? "available"
        : data.status === "Not Available" ? "not-available"
          : data.status === "Temporarily Unavailable" ? "temporarily-unavailable"
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
    document.getElementById("temporarilyUnavailable").setAttribute(
      "aria-pressed",
      String(data.status === "Temporarily Unavailable")
    );
    document.getElementById("publicContactConsent").checked = data.public_contact_consent;
    document.getElementById("publicIdentityConsent").checked = data.public_identity_consent;
    document.getElementById("emergencyResponseConsent").checked = data.emergency_response_consent;
    document.getElementById("availabilityMode").value =
      data.availability_mode === "selected_dates" ? "selected_dates" : "general";
    selectedAvailabilityDates = Array.isArray(data.selected_dates)
      ? data.selected_dates.map(item => ({ date: item.date, status: item.status }))
      : [];
    renderAvailabilityDates();
    message.textContent = !data.eligible_for_matching
      ? `Availability is recorded, but matching requires the next eligible date and a current professional medical review. Next interval date: ${data.next_eligible_date || "not calculated"}.`
      : data.available_until
      ? `Confirmation expiry: ${formatDashboardDate(data.available_until)}.`
      : data.availability_mode === "selected_dates"
        ? "Your schedule applies only to the selected dates shown above."
      : data.last_confirmed_at
        ? "You are not currently listed as available."
        : "You have not confirmed availability yet.";
  } catch (error) {
    console.error("Donor availability could not be loaded:", error);
    message.textContent = error.message;
  }
}

async function loadDonorDonationHistory() {
  const summary = document.getElementById("donationHistorySummary");
  const rows = document.getElementById("donationHistoryRows");
  try {
    const data = await requestJson("/api/donor/eligibility-portal");
    const eligibility = data.summary;
    const lastDonation = eligibility.last_donation_date || "No verified donation recorded";
    const nextEligible = eligibility.next_review_date || "Not calculated";
    summary.textContent = `Last donation: ${lastDonation} · Expected review date: ${nextEligible} · Configured interval: ${eligibility.eligibility_interval_months} calendar month(s).`;
    const statusLabels = {
      eligible_for_review: "Eligible for Review",
      recovery_period_in_progress: "Recovery Period in Progress",
      awaiting_eligibility_review: "Awaiting Eligibility Review",
      eligibility_confirmed: "Eligibility Confirmed",
      temporarily_ineligible: "Temporarily Ineligible",
      medical_review_required: "Medical Review Required"
    };
    document.getElementById("donationEligibilitySummary").textContent =
      `Status: ${statusLabels[eligibility.status] || "Medical Review Required"} · Recovery progress ${eligibility.recovery_progress_percent}% · Live matching: ${eligibility.can_appear_in_live_matching ? "available if you confirm availability" : "not currently available"} · Review request: ${data.review.request_status.replaceAll("_", " ")}.`;
    if (!data.donations.length) {
      rows.replaceChildren(makeTextElement("p", "No verified donation records yet.", "muted"));
      return;
    }
    rows.replaceChildren(...data.donations.map(donation => makeTextElement(
      "p",
      `${donation.donation_date} · Next review date ${donation.next_review_date} · ${donation.verification_status}`,
      "request"
    )));
  } catch (error) {
    summary.textContent = error.message;
  }
}

async function saveDonorAvailability(status) {
  const buttons = [
    document.getElementById("availableToDonate"),
    document.getElementById("notAvailable"),
    document.getElementById("temporarilyUnavailable")
  ];
  const message = document.getElementById("availabilityMessage");
  buttons.push(document.getElementById("saveAvailabilityDates"));
  buttons.forEach(button => { if (button) button.disabled = true; });
  message.textContent = "Saving your availability…";
  const mode = ["not_available", "temporarily_unavailable"].includes(status)
    ? "unavailable"
    : document.getElementById("availabilityMode").value;
  if (mode === "selected_dates" &&
      !selectedAvailabilityDates.some(item => item.status === "available")) {
    message.textContent = "Add at least one future date marked Available before confirming selected-date availability.";
    buttons.forEach(button => { if (button) button.disabled = false; });
    return;
  }
  try {
    const result = await requestJson("/api/availability/status", {
      method: "POST",
      body: JSON.stringify({
        status,
        public_contact_consent: document.getElementById("publicContactConsent").checked,
        public_identity_consent: document.getElementById("publicIdentityConsent").checked,
        emergency_response_consent: document.getElementById("emergencyResponseConsent").checked,
        expires_in_hours: Number(document.getElementById("availabilityExpiry").value),
        mode,
        selected_dates: mode === "selected_dates" ? selectedAvailabilityDates : []
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
      ? mode === "selected_dates"
        ? "Your selected availability dates were saved."
        : `Your availability was saved until ${formatDashboardDate(result.available_until)}.`
      : result.status === "Temporarily Unavailable"
        ? "Your status is Temporarily Unavailable. It will remain off matching until you explicitly confirm availability again."
        : "Your status was saved as Not Available.";
  } catch (error) {
    console.error("Donor availability could not be saved:", error);
    message.textContent = error.message;
  } finally {
    buttons.forEach(button => { if (button) button.disabled = false; });
  }
}

async function loadDonorHealthScreening() {
  const status = document.getElementById("healthScreeningStatus");
  const message = document.getElementById("healthScreeningMessage");
  try {
    const { screening } = await requestJson("/api/donor/health-screening");
    if (!screening) {
      status.textContent = "Pending Review · No screening submitted";
      return;
    }
    const reviewLabel = screening.review_status === "Cleared"
      ? "Cleared by authorized blood-bank staff (not final donation eligibility)"
      : screening.review_status;
    status.textContent = `${reviewLabel} · Submitted ${formatDashboardDate(screening.submitted_at)}${
      screening.reviewed_at ? ` · Reviewed ${formatDashboardDate(screening.reviewed_at)}` : ""
    }`;
    const form = document.getElementById("healthScreeningForm");
    for (const [key, id] of [
      ["feeling_well", "feelingWell"],
      ["recent_illness", "recentIllness"],
      ["taking_medication", "takingMedication"],
      ["receiving_treatment", "receivingTreatment"],
      ["previously_deferred", "previouslyDeferred"]
    ]) {
      form.querySelector(`#${id}`).value = screening.responses?.[key] || "";
    }
    form.elements.screeningLastDonationDate.value = screening.responses?.last_donation_date || "";
    form.elements.medicationName.value = screening.responses?.medication_name || "";
    form.elements.weightKg.value = screening.responses?.weight_kg ?? "";
    form.elements.systolic.value = screening.responses?.blood_pressure_systolic_mmhg ?? "";
    form.elements.diastolic.value = screening.responses?.blood_pressure_diastolic_mmhg ?? "";
    form.elements.healthConditions.value = screening.responses?.health_conditions || "";
    form.elements.temporaryIllness.value = screening.responses?.temporary_illness || "";
    form.elements.healthDataConsent.checked = Boolean(screening.health_data_consent_at);
    if (screening.review_notes) message.textContent = `Reviewer note: ${screening.review_notes}`;
  } catch (error) {
    console.error("Donor health screening could not be loaded:", error);
    status.textContent = "Health screening unavailable";
    message.textContent = error.message;
  }
}

async function submitDonorHealthScreening(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("submitHealthScreening");
  const message = document.getElementById("healthScreeningMessage");
  if (!form.reportValidity()) return;
  button.disabled = true;
  message.textContent = "Submitting your screening for authorized review…";
  try {
    const result = await requestJson("/api/donor/health-screening", {
      method: "POST",
      body: JSON.stringify({
        responses: {
          feeling_well: form.elements.feelingWell.value,
          recent_illness: form.elements.recentIllness.value,
          taking_medication: form.elements.takingMedication.value,
          medication_name: form.elements.medicationName.value.trim(),
          receiving_treatment: form.elements.receivingTreatment.value,
          weight_kg: form.elements.weightKg.value,
          blood_pressure_systolic: form.elements.systolic.value,
          blood_pressure_diastolic: form.elements.diastolic.value,
          health_conditions: form.elements.healthConditions.value.trim(),
          temporary_illness: form.elements.temporaryIllness.value.trim(),
          additional_info: "",
          previously_deferred: form.elements.previouslyDeferred.value,
          last_donation_date: form.elements.screeningLastDonationDate.value,
          health_data_consent: form.elements.healthDataConsent.checked
        }
      })
    });
    document.getElementById("healthScreeningStatus").textContent =
      `${result.screening.review_status} · Submitted ${formatDashboardDate(result.screening.submitted_at)}`;
    message.textContent = result.message;
  } catch (error) {
    console.error("Donor health screening could not be submitted:", error);
    message.textContent = error.message;
  } finally {
    button.disabled = false;
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
        contactText.textContent = "If I accept this request, I consent to sharing my name and phone number with this patient so we can coordinate.";
        contactConsent.append(contactCheckbox, contactText);
        details.append(contactConsent);
        const actions = document.createElement("div");
        actions.className = "request-actions";
        const canHelp = makeTextElement("button", "Accept Request");
        const busy = makeTextElement("button", "Busy / Cannot Donate Now");
        const decline = makeTextElement("button", "Decline Request");
        canHelp.type = "button";
        busy.type = "button";
        decline.type = "button";
        canHelp.disabled = request.can_offer_help !== 1;
        if (canHelp.disabled) {
          details.append(makeTextElement("p", "Confirm current availability and opt into emergency matching to respond Available."));
        }
        canHelp.addEventListener("click", () => respondToEmergencyRequest(
          request.request_id, "can_help", contactCheckbox.checked, actions
        ));
        busy.addEventListener("click", () => respondToEmergencyRequest(
          request.request_id, "busy", false, actions
        ));
        decline.addEventListener("click", () => respondToEmergencyRequest(
          request.request_id, "declined", false, actions
        ));
        actions.append(canHelp, busy, decline);
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
  const actionLabel = response === "can_help" ? "accept this request"
    : response === "busy" ? "busy for this request"
      : "decline this request";
  const contactNotice = response === "can_help" && shareContact
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
        makeTextElement("p", `Responses: ${request.counts.can_help} accepted (confirmation pending), ${request.counts.busy} busy, ${request.counts.cannot_help} declined, ${request.counts.pending} pending, ${request.counts.no_response} no response.`)
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
    state: document.getElementById("searchState").value.trim(),
    city: document.getElementById("searchCity").value.trim(),
    area: document.getElementById("searchArea").value.trim(),
    blood_group: document.getElementById("searchBloodGroup").value
  });
  try {
    const data = await requestJson(`/api/donors/search?${params}`);
    if (!data.donors.length) {
      message.textContent = "No currently confirmed donors found.";
      document.getElementById("requestBlood").value = document.getElementById("searchBloodGroup").value;
      document.getElementById("requestCity").value = document.getElementById("searchCity").value.trim();
      const empty = makeTextElement(
        "p",
        "No donor matched the current eligibility and availability checks. Matching verified LifeDrop bank stock is checked below; you can also open official e-RaktKosh."
      );
      results.append(empty);
      await searchLocalBloodInventory();
      return;
    }
    message.textContent =
      `${data.donors.length} currently confirmed match(es) · Checked ${formatDashboardDate(data.checked_at)}. ${data.location_precision}`;
    const cards = data.donors.map(donor => {
      const card = document.createElement("article");
      card.className = "search-result";
      card.append(
        makeTextElement("strong", `${donor.display_name} · ${donor.blood_group}`),
        makeTextElement("p", `Registered city/state: ${donor.city}, ${donor.state}`),
        makeTextElement("p", `Registered area: ${donor.place || "Not provided"}`),
        makeTextElement("p", `${donor.availability_status} · This is registered profile location, not live GPS.`),
        makeTextElement("p", "Phone number is shown only if this donor accepts your request and separately consents to share contact details."),
        makeTextElement("p", `Last confirmed: ${formatDashboardDate(donor.last_confirmed_at)} · Available until ${formatDashboardDate(donor.available_until)}.`)
      );
      const action = makeTextElement("button", "Request Help");
      action.type = "button";
      action.addEventListener("click", () => {
        document.getElementById("patientRequestCard").hidden = false;
        document.getElementById("requestBlood").value = donor.blood_group;
        document.getElementById("requestCity").value = donor.city;
        document.getElementById("requestDistrict").value = donor.city;
        document.getElementById("requestUnits").value = "1";
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

async function loadPatientRequestStatuses() {
  const container = document.getElementById("patientRequestStatuses");
  const message = document.getElementById("patientRequestStatusMessage");
  if (!container || !message) return;
  try {
    const { requests } = await requestJson("/api/my-blood-requests");
    if (!requests.length) {
      container.replaceChildren(makeTextElement("p", "No emergency requests submitted yet.", "muted"));
      message.textContent = "";
      return;
    }
    container.replaceChildren(...requests.map(request => {
      const article = document.createElement("article");
      article.className = "response";
      article.append(
        makeTextElement("strong", `Request ${request.request_id} · ${request.blood_group} · ${String(request.component || "whole_blood").replaceAll("_", " ")} · ${request.units} unit(s)`),
        makeTextElement("p", `Request submitted: ${request.request_status} · Coordinator status: ${request.coordination_status}.`),
        makeTextElement("p", `Location: ${request.city}${request.district ? `, ${request.district}` : ""} · Needed by ${formatDashboardDate(request.needed_at)}.`, "muted")
      );
      request.events.slice(0, 3).forEach(event => {
        const label = event.event_type === "request_submitted"
          ? "Submitted to LifeDrop"
          : event.event_type === "request_escalated"
            ? "Escalated to LifeDrop coordinator queue"
          : `Authorized coordinator update: ${event.new_status}`;
        article.append(makeTextElement("p", `${label} · ${formatDashboardDate(event.created_at)}`, "muted"));
      });
      const escalated = request.events.some(event => event.event_type === "request_escalated");
      if (request.urgency === "Urgent" && request.coordination_status === "Pending" && !escalated) {
        const escalate = makeTextElement("button", "Escalate to coordinator queue");
        escalate.type = "button";
        escalate.addEventListener("click", async () => {
          escalate.disabled = true;
          try {
            const result = await requestJson(`/api/blood-requests/${request.request_id}/escalate`, { method: "POST" });
            message.textContent = result.message;
            await loadPatientRequestStatuses();
          } catch (error) {
            message.textContent = error.message;
            escalate.disabled = false;
          }
        });
        article.append(escalate);
      }
      return article;
    }));
    message.textContent = "Updates are read from the LifeDrop database; no SMS or email delivery is configured.";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function searchLocalBloodInventory() {
  const button = document.getElementById("searchLocalInventory");
  const message = document.getElementById("localInventoryMessage");
  const results = document.getElementById("localInventoryResults");
  const bloodGroup = document.getElementById("searchBloodGroup").value || document.getElementById("requestBlood").value;
  const component = document.getElementById("requestComponent").value;
  const city = document.getElementById("requestCity").value.trim();
  const state = document.getElementById("searchState").value.trim();
  const district = document.getElementById("requestDistrict").value.trim();
  const requiredUnits = Number(document.getElementById("requestUnits").value || 1);
  if (!bloodGroup) {
    message.textContent = "Choose a blood group before checking stock.";
    return;
  }
  button.disabled = true;
  message.textContent = "Checking staff-reported inventory…";
  try {
    const params = new URLSearchParams({ blood_group: bloodGroup, component, city, state, district, required_units: String(requiredUnits) });
    const data = await requestJson(`/api/blood-stock?${params}`);
    if (!data.inventory.length) {
      results.replaceChildren();
      message.textContent = "No matching verified LifeDrop inventory records are available. Check the official e-RaktKosh link or contact a local blood bank directly.";
      return;
    }
    results.replaceChildren(...data.inventory.map(item => {
      const row = document.createElement("article");
      row.className = "search-result";
      row.append(
        makeTextElement("strong", `${item.bank_name} · ${item.blood_group} · ${item.component.replaceAll("_", " ")}`),
        makeTextElement("p", `${item.available_units === null ? "Units unconfirmed" : `${item.available_units} unit(s)`} · ${item.status}${item.meets_requested_units ? " · Meets requested quantity" : " · Does not meet requested quantity"}`),
        makeTextElement("p", `${item.address || ""}${item.city ? `, ${item.city}` : ""}${item.district ? `, ${item.district}` : ""}${item.state ? `, ${item.state}` : ""} · Stock date ${item.stock_date || "not available"} · Last updated ${formatDashboardDate(item.last_updated)}`, "muted"),
        makeTextElement("p", item.phone ? `Contact: ${item.phone}. Verify current availability before travelling.` : "Contact number not listed; verify current availability directly with the bank.", "muted")
      );
      if (item.phone) {
        const contact = makeTextElement("a", "Enquire about availability");
        contact.href = `tel:${item.phone.replace(/[^\d+]/g, "")}`;
        row.append(contact);
      }
      return row;
    }));
    message.textContent = `LifeDrop inventory checked ${formatDashboardDate(data.checked_at)}.`;
  } catch (error) {
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
  document.getElementById("requestMatchingBanks").replaceChildren();
  try {
    const result = await requestJson("/api/blood-requests", {
      method: "POST",
      body: JSON.stringify({
        patient: dashboardUser.full_name,
        blood: document.getElementById("requestBlood").value,
        component: form.elements.component.value,
        units: Number(form.elements.units.value),
        urgency: form.elements.urgency.value,
        hospital_name: form.elements.hospital_name.value.trim(),
        hospital_address: form.elements.hospital_address.value.trim(),
        city: form.elements.city.value.trim(),
        state: "Karnataka",
        district: form.elements.district.value.trim(),
        contact_phone: form.elements.contact_phone.value.trim(),
        needed_at: neededAt.toISOString(),
        consent: form.elements.consent.checked,
        match_donors: form.elements.match_donors.checked
      })
    });
    message.textContent = result.matched_donor_count
      ? `${result.message} ${result.matched_donor_count} matching donor notification(s) were saved.`
      : `${result.message} No opted-in donors matched this exact blood group and city.`;
    const bankMatches = result.matching_blood_banks || [];
    if (bankMatches.length) {
      const container = document.getElementById("requestMatchingBanks");
      container.append(makeTextElement("h3", "Matching verified blood banks"));
      container.append(makeTextElement("p", "Reported stock met your requested quantity when the request was submitted. This does not reserve stock; confirm directly with the bank."));
      container.append(...bankMatches.map(bank => {
        const row = document.createElement("article");
        row.className = "search-result";
        row.append(
          makeTextElement("strong", bank.bank_name),
          makeTextElement("p", `${bank.available_units} ${form.elements.component.value.replaceAll("_", " ")} unit(s) · ${bank.city || ""}${bank.district ? `, ${bank.district}` : ""}${bank.state ? `, ${bank.state}` : ""}`),
          makeTextElement("p", `Stock date ${bank.stock_date || "not available"} · Last updated ${formatDashboardDate(bank.last_updated)}. Stock is reported, not reserved.`)
        );
        if (bank.phone) {
          const contact = makeTextElement("a", "Enquire about availability");
          contact.href = `tel:${bank.phone.replace(/[^\d+]/g, "")}`;
          row.append(contact);
        }
        return row;
      }));
    }
    if (result.bank_staff_notifications_created) {
      message.textContent += ` ${result.bank_staff_notifications_created} authorized bank staff notification(s) were saved in-app.`;
    }
    await loadPatientResponses();
    await loadPatientRequestStatuses();
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
    if (window.LifeDropNotifications) window.LifeDropNotifications.start();
    const expectedRole = isPatientDashboard ? "patient" : "donor";
    if (user.role !== expectedRole) {
      const dashboardByRole = {
        donor: "/donar-dashboard.html",
        patient: "/patient-dashboard.html",
        blood_bank: "/blood-bank-portal.html"
      };
      window.location.replace(dashboardByRole[user.role] || "/login");
      return;
    }
    welcome.textContent = `Welcome, ${user.full_name}.`;
    logoutButton.hidden = false;

    if (user.role === "donor") {
      document.getElementById("profileLocationCard").hidden = false;
      const locationForm = document.getElementById("profileLocationForm");
      locationForm.elements.city.value = user.city || "";
      locationForm.elements.state.value = user.state || "";
      locationForm.elements.place.value = user.place || "";
      locationForm.addEventListener("submit", saveDonorProfileLocation);
      await loadDonorAvailability();
      document.getElementById("donationHistoryCard").hidden = false;
      await loadDonorDonationHistory();
      document.getElementById("availabilityCard").hidden = false;
      document.getElementById("healthScreeningCard").hidden = false;
      document.getElementById("healthScreeningForm").addEventListener("submit", submitDonorHealthScreening);
      await loadDonorHealthScreening();
      document.getElementById("emergencyRequestsCard").hidden = false;
      await loadDonorEmergencyRequests();
      window.setInterval(loadDonorAvailability, 15000);
      window.setInterval(loadDonorEmergencyRequests, 30000);
    } else {
      document.getElementById("searchCity").value = user.city || "Mysuru";
      document.getElementById("searchState").value = user.state || "Karnataka";
      document.getElementById("requestCity").value = user.city || "Mysuru";
      document.getElementById("requestDistrict").value = user.city || "Mysuru";
      document.getElementById("requestContactPhone").value = user.phone || "";
      const defaultNeededAt = new Date(Date.now() + 60 * 60 * 1000);
      defaultNeededAt.setMinutes(defaultNeededAt.getMinutes() - defaultNeededAt.getTimezoneOffset());
      document.getElementById("requestNeededAt").value = defaultNeededAt.toISOString().slice(0, 16);
      document.getElementById("requestBlood").value = document.getElementById("searchBloodGroup").value;
      document.getElementById("searchBloodGroup").addEventListener("change", event => {
        document.getElementById("requestBlood").value = event.currentTarget.value;
      });
      document.getElementById("patientDonorSearchForm").addEventListener("submit", searchPatientDonors);
      document.getElementById("patientEmergencyRequestForm").addEventListener("submit", submitPatientEmergencyRequest);
      document.getElementById("searchLocalInventory").addEventListener("click", searchLocalBloodInventory);
      document.getElementById("patientRequestStatusCard").hidden = false;
      document.getElementById("patientResponsesCard").hidden = false;
      await loadPatientResponses();
      await loadPatientRequestStatuses();
      window.setInterval(loadPatientResponses, 30000);
      window.setInterval(loadPatientRequestStatuses, 30000);
    }
  } catch (error) {
    console.error("Dashboard login verification failed:", error);
    welcome.textContent = error.status === 401
      ? "Please log in to view your dashboard."
      : `Could not verify your login: ${error.message}`;
  }
}

async function saveDonorProfileLocation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("saveProfileLocation");
  const message = document.getElementById("profileLocationMessage");
  if (!form.reportValidity()) return;
  button.disabled = true;
  message.textContent = "Saving your registered location…";
  try {
    const result = await requestJson("/api/donor/profile-location", {
      method: "PATCH",
      body: {
        city: form.elements.city.value.trim(),
        state: form.elements.state.value.trim(),
        place: form.elements.place.value.trim()
      }
    });
    dashboardUser = { ...dashboardUser, ...result.location };
    message.textContent = "Your registered location was saved. Patient search will use this city and area when you opt in.";
    try {
      localStorage.setItem("lifedrop-availability-updated", String(Date.now()));
    } catch (error) {
      console.warn("Could not signal the open admin dashboard to refresh:", error);
    }
  } catch (error) {
    console.error("Donor profile location could not be saved:", error);
    message.textContent = error.message;
  } finally {
    button.disabled = false;
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

document.getElementById("temporarilyUnavailable")?.addEventListener("click", () => {
  saveDonorAvailability("temporarily_unavailable");
});

document.getElementById("availabilityMode")?.addEventListener("change", renderAvailabilityDates);
document.getElementById("addAvailabilityDate")?.addEventListener("click", () => {
  const input = document.getElementById("availabilityDate");
  const date = input.value;
  const today = new Date().toISOString().slice(0, 10);
  if (!date || date <= today) {
    document.getElementById("availabilityMessage").textContent =
      "Choose a date after today.";
    return;
  }
  if (selectedAvailabilityDates.some(item => item.date === date)) {
    document.getElementById("availabilityMessage").textContent =
      "That date is already in your list.";
    return;
  }
  selectedAvailabilityDates.push({ date, status: "available" });
  input.value = "";
  document.getElementById("availabilityMessage").textContent =
    "Date added. Save your selected dates to update your availability.";
  renderAvailabilityDates();
});

document.getElementById("saveAvailabilityDates")?.addEventListener("click", () => {
  saveDonorAvailability("available");
});

loadDashboard();
