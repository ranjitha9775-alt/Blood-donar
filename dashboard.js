"use strict";

let dashboardUser = null;
let verifiedDonationDate = null;
let pendingDonationReport = null;
let isPatientDonorSearchRunning = false;
let patientLiveAvailabilitySearchId = 0;
let patientRequestSubmissionInProgress = false;
let hasPatientDonorSearchRun = false;
let hasPatientLiveAvailabilitySearchRun = false;

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

function getPatientRequestStatusLabel(status) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "confirmed") return "Request Confirmed by Administrator";
  if (normalizedStatus === "not confirmed") return "Request Not Confirmed by Administrator";
  if (["pending", "pending verification", "under review", "open"].includes(normalizedStatus)) {
    return "Pending Administrator Confirmation";
  }
  if (normalizedStatus === "fulfilled") return "Fulfilled — Patient Confirmed Blood Received";
  if (normalizedStatus === "cancelled" || normalizedStatus === "canceled") return "Cancelled";
  return status || "Status unavailable";
}

async function loadDonorAvailability() {
  const message = document.getElementById("availabilityMessage");
  try {
    const data = await requestJson("/api/availability/status");
    verifiedDonationDate = data.verified_last_donation_date || null;
    pendingDonationReport = data.pending_donation_report || null;
    const status = document.getElementById("availabilityStatus");
    const isAvailable = data.status === "Available";
    const displayedStatus = isAvailable ? "Available" : "Not Available";
    status.textContent = displayedStatus;
    status.className = `status-label ${isAvailable ? "available" : "not-available"}`;
    status.dataset.reason = data.unavailability_reason || "";
    document.getElementById("lastConfirmedAt").textContent =
      formatDashboardDate(data.last_confirmed_at);
    const toggle = document.getElementById("availabilityToggle");
    toggle.setAttribute("aria-pressed", String(isAvailable));
    document.getElementById("availabilityCurrentMessage").textContent =
      isAvailable ? "Currently Available" : "Currently Not Available";
    const savedReason = document.querySelector(
      `input[name="unavailabilityReason"][value="${data.unavailability_reason || ""}"]`
    );
    if (savedReason) savedReason.checked = true;
    document.getElementById("verifiedDonationDateMessage").hidden =
      !verifiedDonationDate || Boolean(pendingDonationReport);
    document.getElementById("verifiedDonationDateMessage").textContent =
      verifiedDonationDate ? `Last verified donation: ${verifiedDonationDate}.` : "";
    document.getElementById("reportedDonationDateField").hidden =
      Boolean(verifiedDonationDate) || Boolean(pendingDonationReport);
    if (pendingDonationReport) {
      document.getElementById("unavailabilityMessage").textContent =
        `Your reported donation date (${pendingDonationReport.donation_date}) is awaiting authorized verification.`;
    }
    document.getElementById("publicContactConsent").checked = data.public_contact_consent;
    document.getElementById("publicIdentityConsent").checked = data.public_identity_consent;
    document.getElementById("publicPhoneConsent").checked = data.public_phone_consent;
    document.getElementById("emergencyResponseConsent").checked = data.emergency_response_consent;
    message.textContent = !data.eligible_for_matching
      ? `Your saved status is ${displayedStatus}. Patient matching also requires a current professional medical review. Next interval date: ${data.next_eligible_date || "not calculated"}.`
      : data.availability_status === "available" && !isAvailable
        ? "Your Available confirmation has expired. Select Available to confirm again."
        : isAvailable
          ? `Your saved status is Available until ${formatDashboardDate(data.available_until)}.`
          : data.last_confirmed_at
            ? "Your saved status is Not Available."
            : "You have not confirmed availability yet.";
    const matchingBlockers = [];
    if (!isAvailable) {
      matchingBlockers.push("confirm Available with a current confirmation");
    }
    if (!data.eligible_for_matching) matchingBlockers.push("complete screening and receive current qualified-staff eligibility approval");
    if (!data.public_contact_consent) matchingBlockers.push("enable sharing of blood group and city/state in Live Donor Search");
    document.getElementById("donorMatchingReadiness").textContent = matchingBlockers.length
      ? `Patient search: not currently matchable. To appear, ${matchingBlockers.join("; ")}.`
      : "Patient search: your current confirmation, eligibility, and search-sharing settings pass the donor-side checks. Patients must still search for a compatible blood group and your registered city/state.";
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
    document.getElementById("donorProfileBloodGroup").textContent =
      eligibility.blood_group || "Not recorded";
    document.getElementById("donorProfileLocation").textContent =
      [dashboardUser?.city, dashboardUser?.place, dashboardUser?.state]
        .filter(Boolean)
        .join(", ") || "Not recorded";
    const lastDonation = eligibility.last_donation_date || "No verified donation recorded";
    const nextEligible = eligibility.next_review_date || "Not calculated";
    const remaining = eligibility.remaining_waiting_days;
    summary.textContent = `Last recorded donation: ${lastDonation} · Next eligible donation date (preliminary): ${nextEligible} · Remaining configured waiting period: ${remaining === null ? "not applicable" : `${remaining} day(s)`} · Configured interval: ${eligibility.eligibility_interval_months} calendar month(s).`;
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

async function saveDonorAvailability(status, options = {}) {
  const buttons = [
    document.getElementById("availabilityToggle"),
    document.getElementById("notAvailableButton"),
    document.getElementById("confirmNotAvailable")
  ];
  const message = document.getElementById("availabilityMessage");
  buttons.forEach(button => { if (button) button.disabled = true; });
  message.textContent = "Saving your availability…";
  const mode = options.mode || (status === "not_available" ? "unavailable" : "general");
  try {
    const result = await requestJson("/api/availability/status", {
      method: "POST",
      body: JSON.stringify({
        status,
        public_contact_consent: document.getElementById("publicContactConsent").checked,
        public_identity_consent: document.getElementById("publicIdentityConsent").checked,
        public_phone_consent: document.getElementById("publicPhoneConsent").checked,
        emergency_response_consent: document.getElementById("emergencyResponseConsent").checked,
        mode,
        ...(options.unavailabilityReason ? {
          unavailability_reason: options.unavailabilityReason,
          reported_donation_date: options.reportedDonationDate || null
        } : {})
      })
    });
    try {
      await loadDonorAvailability();
      await loadDonorEmergencyRequests();
      if (window.LifeDropNotifications) {
        await window.LifeDropNotifications.refresh();
      }
      document.dispatchEvent(new Event("lifedrop:notifications-updated"));
      try {
        localStorage.setItem("lifedrop-availability-updated", String(Date.now()));
        localStorage.setItem("lifedrop-notifications-updated", String(Date.now()));
      } catch (error) {
        console.warn("Could not signal the open admin dashboard to refresh:", error);
      }
    } catch (error) {
      console.error("Availability was saved, but the dashboard could not refresh:", error);
      message.textContent =
        "Your donor availability has been updated, but the dashboard could not refresh. Reload the page to see the saved status.";
      return true;
    }
    message.textContent = options.unavailabilityReason
      ? "Your donor availability has been updated." +
        (result.donation_report_status === "pending"
          ? ` Your reported donation date (${result.reported_donation_date}) is awaiting authorized verification; availability cannot be restored until it is reviewed.`
          : "")
      : result.status === "Available"
        ? `Saved: your status is Available${result.available_until ? ` until ${formatDashboardDate(result.available_until)}` : ""}. Matching still requires eligibility and consent.`
        : "Saved: your status is Not Available. You will not appear in available donor search.";
    return true;
  } catch (error) {
    console.error("Donor availability could not be saved:", error);
    const errorTarget = options.unavailabilityReason
      ? document.getElementById("unavailabilityMessage")
      : message;
    errorTarget.textContent = error.message;
    return false;
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
      if (request.patient_selected) {
        details.append(makeTextElement(
          "p",
          "The patient selected you for coordination. Please coordinate directly with the patient and their hospital or blood bank; this is not medical approval."
        ));
      }
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
        const canHelp = makeTextElement("button", "Confirm I Can Help");
        const busy = makeTextElement("button", "Busy / Cannot Donate Now");
        const decline = makeTextElement("button", "Decline Request");
        canHelp.type = "button";
        busy.type = "button";
        decline.type = "button";
        canHelp.disabled = request.can_offer_help !== 1;
        if (canHelp.disabled) {
          details.append(makeTextElement("p", "You can confirm only when emergency-request consent, current medical eligibility, cooldown, and availability rules allow it."));
        } else {
          details.append(makeTextElement("p", "Confirming applies only to this request. It does not change your normal availability or medical clearance.", "muted"));
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
        makeTextElement(
          "p",
          `Request status: ${getPatientRequestStatusLabel(request.request_status)} · Donor status: ${request.status}. Needed by ${formatDashboardDate(request.needed_at)}.`
        ),
        makeTextElement("p", `Responses: ${request.counts.can_help} accepted, ${request.counts.busy} busy, ${request.counts.cannot_help} declined, ${request.counts.pending} pending, ${request.counts.no_response} no response.`)
      );
      if (request.selected_donor_confirmed_at) {
        card.append(makeTextElement(
          "p",
          `Selected for coordination: ${formatDashboardDate(request.selected_donor_confirmed_at)}. This is not medical approval.`
        ));
      }
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
        if (donorResponse.patient_selected) {
          responseLine.append(makeTextElement("p", "Donor Selected — Coordination Pending."));
        } else if (donorResponse.can_select && !request.has_selected_donor) {
          const selectButton = makeTextElement(
            "button",
            "Select Donor for Coordination"
          );
          selectButton.type = "button";
          selectButton.addEventListener("click", () =>
            confirmPatientDonor(request.request_id, donorResponse.donor_response_id, selectButton)
          );
          responseLine.append(selectButton);
        } else if (donorResponse.can_select && request.has_selected_donor) {
          responseLine.append(makeTextElement("p", "Another donor is already selected for coordination.", "muted"));
        } else if (donorResponse.status.startsWith("Accepted")) {
          responseLine.append(makeTextElement(
            "p",
            "This donor has not consented to share contact details, so they cannot be selected for coordination here.",
            "muted"
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

async function confirmPatientDonor(requestId, donorUserId, button) {
  if (!donorUserId) return;
  if (!window.confirm(
    "Select this donor for coordination? This does not confirm medical compatibility or eligibility. Coordinate with the hospital or blood bank."
  )) return;
  button.disabled = true;
  const messages = [
    document.getElementById("patientResponsesMessage"),
    document.getElementById("patientRequestStatusMessage")
  ].filter(Boolean);
  messages.forEach(message => {
    message.textContent = "Saving your selection…";
  });
  try {
    const result = await requestJson(
      `/api/my-emergency-requests/${encodeURIComponent(requestId)}/confirm-donor`,
      {
        method: "POST",
        body: JSON.stringify({ donor_user_id: donorUserId })
      }
    );
    await loadPatientResponses();
    await loadPatientRequestStatuses();
    messages.forEach(message => {
      message.textContent = result.message;
    });
  } catch (error) {
    console.error("Patient donor selection could not be saved:", error);
    await loadPatientResponses();
    await loadPatientRequestStatuses();
    messages.forEach(message => {
      message.textContent = error.message;
    });
  }
}

async function confirmBloodReceived(requestId, button) {
  if (!window.confirm(
    "Confirm only if the requested blood has actually been received. This will mark the request Fulfilled."
  )) return;
  button.disabled = true;
  const message = document.getElementById("patientRequestStatusMessage");
  message.textContent = "Saving your blood-received confirmation…";
  try {
    const result = await requestJson(
      `/api/blood-requests/${encodeURIComponent(requestId)}/confirm-received`,
      {
        method: "POST",
        body: JSON.stringify({ received: true })
      }
    );
    await loadPatientRequestStatuses();
    await loadPatientResponses();
    message.textContent = result.message;
  } catch (error) {
    console.error("Blood receipt confirmation could not be saved:", error);
    message.textContent = error.message;
    button.disabled = false;
  }
}

async function searchPatientDonors(event, isRefresh = false) {
  if (event) event.preventDefault();
  if (isPatientDonorSearchRunning) return;
  const form = document.getElementById("patientDonorSearchForm");
  const button = document.getElementById("searchDonorsButton");
  const message = document.getElementById("donorSearchMessage");
  const results = document.getElementById("donorSearchResults");
  if (!isRefresh && !form.reportValidity()) return;
  isPatientDonorSearchRunning = true;
  button.disabled = true;
  if (!isRefresh) {
    results.replaceChildren();
    message.textContent = "Searching current donor confirmations…";
  }
  const params = new URLSearchParams({
    city: document.getElementById("searchCity").value.trim().replace(/\s+/g, " "),
    blood_group: document.getElementById("searchBloodGroup").value
  });
  const searchArea = document.getElementById("searchArea").value.trim().replace(/\s+/g, " ");
  if (searchArea) params.set("area", searchArea);
  const searchState = document.getElementById("searchState").value.trim().replace(/\s+/g, " ");
  const urgency = document.getElementById("searchUrgency").value;
  if (searchState) params.set("state", searchState);
  if (urgency) params.set("urgency", urgency);
  const requiredDate = document.getElementById("searchRequiredDate").value;
  if (requiredDate) params.set("required_date", requiredDate);
  try {
    const data = await requestJson(`/api/donors/search?${params}`);
    hasPatientDonorSearchRun = true;
    if (!data.donors.length) {
      message.textContent = `No donors passed the current matching checks · Checked ${formatDashboardDate(data.checked_at)}.`;
      document.getElementById("requestBlood").value = document.getElementById("searchBloodGroup").value;
      document.getElementById("requestCity").value = document.getElementById("searchCity").value.trim();
      const diagnostics = data.search_diagnostics;
      let reason = requiredDate
        ? "No donor matched the blood-group compatibility, registered city/state, current confirmation for that date, donor-sharing consent, and eligibility checks."
        : "No donor matched the blood-group compatibility, registered city/state, current general confirmation, donor-sharing consent, and eligibility checks.";
      if (diagnostics) {
        const reasons = [];
        if (diagnostics.location_and_blood_group_matches === 0) {
          reasons.push("No registered donors in this city/state have a compatible blood group.");
        } else {
          if (diagnostics.marked_available === 0) {
            reasons.push("Matching donors have not confirmed that they are currently available.");
          } else if (diagnostics.confirmed === 0) {
            reasons.push("Matching donors have no availability confirmation recorded.");
          }
          if (diagnostics.search_consent === 0) {
            reasons.push("No matching donor has opted into patient search.");
          }
          if (diagnostics.cooldown_clear === 0) {
            reasons.push("Matching donors remain within the donation waiting period.");
          }
          if (diagnostics.requested_schedule_matches === 0) {
            reasons.push(requiredDate
              ? "No matching donor has confirmed availability on the selected date."
              : "No matching donor has a current general availability window.");
          }
          if (diagnostics.medically_eligible === 0 &&
              diagnostics.confirmed_searchable_cooldown_matches > 0) {
            const count = diagnostics.confirmed_searchable_cooldown_matches;
            reasons.push(
              `${count} compatible donor${count === 1 ? " has" : "s have"} confirmed availability, opted into search, and passed the donation waiting period, but cannot appear until a qualified staff member clears the current health screening and eligibility review.`
            );
          } else if (diagnostics.medically_eligible === 0) {
            reasons.push("Matching donors still need current screening clearance and qualified-staff eligibility approval.");
          }
        }
        if (reasons.length) reason = reasons.join(" ");
      }
      const empty = makeTextElement(
        "p",
        `${reason} ${!requiredDate ? "Donors who selected specific dates are included when you search for one of those dates. " : ""}Confirm the entered details or check reported blood-bank stock and official e-RaktKosh.`
      );
      results.replaceChildren(empty);
      if (!isRefresh) await searchLocalBloodInventory();
      return;
    }
    message.textContent =
      `${data.donors.length} currently confirmed match(es) · Checked ${formatDashboardDate(data.checked_at)}. ${searchArea ? `Same-locality donors are prioritized; other matches in ${data.search_area} follow. ` : ""}${data.location_precision}`;
    const cards = data.donors.map(donor => {
      const card = document.createElement("article");
      card.className = "search-result";
      card.append(
        makeTextElement("strong", `${donor.display_name || "Donor (name not shared)"} · ${donor.blood_group}`),
        makeTextElement("p", `Registered city: ${donor.city}`),
        ...(donor.place ? [makeTextElement("p", `Registered area: ${donor.place}`)] : []),
        makeTextElement("p", `${donor.availability_status} · This is registered profile location, not live GPS.`),
        makeTextElement("p", "Donor availability is not confirmation of a specific request or medical clearance."),
        makeTextElement("p", `Last confirmed: ${formatDashboardDate(donor.last_confirmed_at)} · Available until ${formatDashboardDate(donor.available_until)}.`)
      );
      return card;
    });
    results.replaceChildren(...cards);
  } catch (error) {
    console.error("Patient donor search failed:", error);
    results.replaceChildren();
    message.textContent = error.message;
  } finally {
    isPatientDonorSearchRunning = false;
    button.disabled = false;
  }
}

async function searchPatientLiveDonors(event) {
  if (event) event.preventDefault();
  const form = document.getElementById("patientDonorSearchForm");
  const button = document.getElementById("refreshLiveDonorsButton");
  const message = document.getElementById("liveDonorAvailabilityMessage");
  const results = document.getElementById("liveDonorAvailabilityResults");
  const requestCard = document.getElementById("patientRequestCard");
  requestCard.hidden = true;
  if (!form.reportValidity()) {
    patientLiveAvailabilitySearchId += 1;
    button.disabled = false;
    return;
  }

  const searchId = ++patientLiveAvailabilitySearchId;
  hasPatientLiveAvailabilitySearchRun = true;
  button.disabled = true;
  message.textContent = results.childElementCount
    ? "Refreshing live donor availability…"
    : "Loading live donor availability…";

  const params = new URLSearchParams({
    city: document.getElementById("searchCity").value.trim().replace(/\s+/g, " "),
    blood_group: document.getElementById("searchBloodGroup").value
  });
  const area = document.getElementById("searchArea").value.trim().replace(/\s+/g, " ");
  const state = document.getElementById("searchState").value.trim().replace(/\s+/g, " ");
  if (area) params.set("area", area);
  if (state) params.set("state", state);

  try {
    const data = await requestJson(`/api/availability?${params}`, { cache: "no-store" });
    if (searchId !== patientLiveAvailabilitySearchId) return;
    if (!data.donors.length) {
      results.replaceChildren();
      message.textContent = "No available donors found for your selected blood group and location.";
      document.getElementById("requestBlood").value = document.getElementById("searchBloodGroup").value;
      document.getElementById("requestCity").value = document.getElementById("searchCity").value.trim();
      document.getElementById("requestDistrict").value = document.getElementById("searchArea").value.trim() ||
        document.getElementById("searchCity").value.trim();
      document.getElementById("targetDonorUserId").value = "";
      document.getElementById("contactTargetState").value = "";
      document.getElementById("contactTargetSummary").hidden = true;
      document.getElementById("confirmEmergencyRequest").checked = false;
      requestCard.hidden = false;
      return;
    }

    const cards = data.donors.map(donor => {
      const card = document.createElement("article");
      card.className = "live-donor-result";
      const name = donor.name || "Donor (name not shared)";
      const areaValue = donor.place || (donor.identity_consent ? "Not provided" : "Not shared");
      const phone = donor.phone || "Not shared";
      card.append(
        makeTextElement("h3", name),
        makeTextElement("p", `Blood group: ${donor.blood_group}`),
        makeTextElement("p", `City: ${donor.city}`),
        makeTextElement("p", `Area: ${areaValue}`),
        makeTextElement("p", `Phone: ${phone}`),
        makeTextElement(
          "p",
          `Availability status: ${donor.patient_availability_status || donor.availability_status}`
        ),
        ...(donor.medical_clearance_status === "Medical Clearance Pending"
          ? [makeTextElement(
            "p",
            "Final medical clearance is pending. Do not proceed with donation until authorized personnel complete screening and approve eligibility.",
            "safety"
          )]
          : [])
      );
      return card;
    });
    results.replaceChildren(...cards);
    message.textContent = `Showing ${cards.length} available donor(s). Last refreshed ${formatDashboardDate(data.checked_at)}.`;
  } catch (error) {
    if (searchId !== patientLiveAvailabilitySearchId) return;
    console.error("Live donor availability could not be loaded:", error);
    results.replaceChildren();
    message.textContent = `Live donor availability could not be loaded: ${error.message}`;
    requestCard.hidden = true;
  } finally {
    if (searchId === patientLiveAvailabilitySearchId) {
      button.disabled = false;
    }
  }
}

async function loadPatientRequestStatuses() {
  const container = document.getElementById("patientRequestStatuses");
  const message = document.getElementById("patientRequestStatusMessage");
  if (!container || !message) return;
  try {
    const { requests } = await requestJson("/api/my-blood-requests", { cache: "no-store" });
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
        makeTextElement(
          "p",
          `Overall request status: ${getPatientRequestStatusLabel(request.request_status)} · Coordinator status: ${request.coordination_status}.`
        ),
        makeTextElement("p", `Location: ${request.city}${request.district ? `, ${request.district}` : ""} · Needed by ${formatDashboardDate(request.needed_at)}.`, "muted")
      );
      const donorResponses = request.donor_responses || [];
      const selectedDonorResponse = donorResponses.find(response => response.patient_selected);
      const hasDonorConfirmation = donorResponses.some(response => response.status === "Donor Confirmed");
      article.append(makeTextElement(
        "p",
        `Donor selection: ${
          selectedDonorResponse
            ? request.request_status === "Fulfilled"
              ? "Donor Selected — Blood Receipt Confirmed"
              : "Donor Selected — Coordination Pending"
            : hasDonorConfirmation
              ? "Donor confirmed — patient selection pending"
              : "No donor selected"
        }`
      ));
      article.append(makeTextElement("p", "Donor response status:"));
      if (donorResponses.length) {
        donorResponses.forEach(response => {
          const responseLine = document.createElement("div");
          responseLine.append(makeTextElement(
            "p",
            `${response.status}${response.donor_name ? ` · ${response.donor_name}` : ""}`,
            "muted"
          ));
          if (response.can_select && response.donor_response_id) {
            const confirmButton = makeTextElement("button", "Select Donor for Coordination");
            confirmButton.type = "button";
            confirmButton.addEventListener("click", () =>
              confirmPatientDonor(request.request_id, response.donor_response_id, confirmButton)
            );
            responseLine.append(confirmButton);
          } else if (response.patient_selected) {
            responseLine.append(makeTextElement(
              "p",
              "Donor Selected — Coordination Pending. This does not change the request status or confirm blood receipt.",
              "muted"
            ));
          } else if (response.status === "Donor Confirmed" && !response.donor_response_id) {
            responseLine.append(makeTextElement(
              "p",
              "This donor has not consented to share contact details, so they cannot be selected for coordination.",
              "muted"
            ));
          }
          article.append(responseLine);
        });
      } else {
        const requestClosed = ["fulfilled", "cancelled"].includes(
          String(request.request_status || "").toLowerCase()
        );
        article.append(makeTextElement(
          "p",
          requestClosed ? "No Donor Response" : "Waiting for Donor Response",
          "muted"
        ));
      }
      if (!["Fulfilled", "Cancelled"].includes(request.request_status)) {
        const receivedButton = makeTextElement("button", "Confirm Blood Received");
        receivedButton.type = "button";
        receivedButton.addEventListener("click", () =>
          confirmBloodReceived(request.request_id, receivedButton)
        );
        article.append(
          makeTextElement(
            "p",
            "Only confirm after the requested blood has actually been received.",
            "muted"
          ),
          receivedButton
        );
      }
      request.events.slice(0, 3).forEach(event => {
        const label = event.event_type === "request_submitted"
          ? "Submitted to LifeDrop"
          : event.event_type === "request_escalated"
            ? "Escalated to LifeDrop coordinator queue"
            : event.event_type === "request_status_self_reported"
              ? `Patient self-reported status: ${event.new_status}`
              : event.event_type === "admin_request_confirmed"
                ? "Request Confirmed by administrator"
                : event.event_type === "admin_request_not_confirmed"
                  ? "Request marked Not Confirmed by administrator"
              : event.event_type === "patient_confirmed_blood_received"
                ? "Patient confirmed blood received"
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
  if (patientRequestSubmissionInProgress) return;
  if (!form.elements.consent.checked) {
    message.textContent = "Consent to securely store this request is required before it can be submitted.";
    return;
  }
  if (form.elements.match_donors.checked && form.elements.urgency.value !== "Urgent") {
    message.textContent = "Donor notification consent is available only for requests marked Urgent.";
    return;
  }
  if (!form.reportValidity()) return;
  if (!document.getElementById("confirmEmergencyRequest").checked) {
    message.textContent = "Review the request details and confirm before submitting.";
    return;
  }
  const neededAt = new Date(form.elements.needed_at.value);
  if (!Number.isFinite(neededAt.getTime()) || neededAt.getTime() <= Date.now()) {
    message.textContent = "Choose a future date and time, or contact the hospital immediately for urgent needs.";
    return;
  }
  patientRequestSubmissionInProgress = true;
  button.disabled = true;
  message.textContent = "Saving the request and matching opted-in donors…";
  document.getElementById("requestMatchingBanks").replaceChildren();
  try {
    const result = await requestJson("/api/blood-requests", {
      method: "POST",
      body: JSON.stringify({
        patient: dashboardUser.full_name,
        blood: document.getElementById("requestBlood").value,
        target_donor_token: document.getElementById("targetDonorUserId").value || null,
        availability_search_area: document.getElementById("searchArea").value.trim(),
        component: form.elements.component.value,
        units: Number(form.elements.units.value),
        urgency: form.elements.urgency.value,
        hospital_name: form.elements.hospital_name.value.trim(),
        hospital_address: form.elements.hospital_address.value.trim(),
        city: form.elements.city.value.trim(),
        state: document.getElementById("contactTargetState").value ||
          document.getElementById("searchState").value.trim() || dashboardUser.state || "Karnataka",
        district: form.elements.district.value.trim(),
        contact_phone: form.elements.contact_phone.value.trim(),
        needed_at: neededAt.toISOString(),
        consent: form.elements.consent.checked,
        confirm_request: document.getElementById("confirmEmergencyRequest").checked,
        match_donors: form.elements.match_donors.checked
      })
    });
    const requestId = `LD-${result.request_id}`;
    message.textContent = result.matched_donor_count
      ? `Request ${requestId} saved successfully. Status: Pending Verification. ${result.matched_donor_count} matching donor notification(s) were saved in-app. No email, SMS, or push notification was sent.`
      : result.donor_notifications_requested
        ? `Request ${requestId} saved successfully. Status: Pending Verification. No eligible, available, opted-in donors matched this request.`
        : `Request ${requestId} saved successfully. Status: Pending Verification. Donor notifications were not requested.`;
    document.getElementById("targetDonorUserId").value = "";
    document.getElementById("contactTargetState").value = "";
    document.getElementById("contactTargetSummary").hidden = true;
    document.getElementById("confirmEmergencyRequest").checked = false;
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
    patientRequestSubmissionInProgress = false;
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
      const bloodGroupSummary = document.getElementById("donorBloodGroupSummary");
      document.getElementById("donorBloodGroupValue").textContent = user.blood_group || "Not recorded";
      bloodGroupSummary.hidden = false;
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
      if (window.location.hash === "#availabilityCard") {
        window.requestAnimationFrame(() => {
          document.getElementById("availabilityCard").scrollIntoView({ block: "start" });
        });
      }
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
      const patientBloodGroup = String(user.blood_group || "").trim().toUpperCase();
      const bloodGroupSelect = document.getElementById("searchBloodGroup");
      if ([...bloodGroupSelect.options].some(option => option.value === patientBloodGroup)) {
        bloodGroupSelect.value = patientBloodGroup;
      }
      const requiredDateInput = document.getElementById("searchRequiredDate");
      requiredDateInput.min = new Date().toISOString().slice(0, 10);
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
      document.getElementById("patientDonorSearchForm").addEventListener("submit", searchPatientLiveDonors);
      document.getElementById("refreshLiveDonorsButton").addEventListener("click", searchPatientLiveDonors);
      ["searchCity", "searchArea", "searchState", "searchBloodGroup"].forEach(id => {
        document.getElementById(id).addEventListener("change", searchPatientLiveDonors);
      });
      if (bloodGroupSelect.value) {
        await searchPatientLiveDonors();
      }
      document.getElementById("patientEmergencyRequestForm").addEventListener("submit", submitPatientEmergencyRequest);
      document.getElementById("searchLocalInventory").addEventListener("click", searchLocalBloodInventory);
      document.getElementById("patientRequestStatusCard").hidden = false;
      document.getElementById("patientResponsesCard").hidden = false;
      document.getElementById("refreshPatientRequestsButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await loadPatientRequestStatuses();
          await loadPatientResponses();
        } finally {
          button.disabled = false;
        }
      });
      await loadPatientResponses();
      await loadPatientRequestStatuses();
      if (new URLSearchParams(window.location.search).get("open") === "request") {
        document.getElementById("welcome").textContent =
          `Welcome, ${user.full_name}. Check matching donor availability first; the emergency request form appears only when no matching available donor is found.`;
        window.requestAnimationFrame(() => {
          document.getElementById("donorSearchTitle").scrollIntoView({ block: "start", behavior: "smooth" });
          document.getElementById("searchBloodGroup").focus({ preventScroll: true });
        });
      }
      window.setInterval(loadPatientResponses, 30000);
      window.setInterval(loadPatientRequestStatuses, 30000);
      window.setInterval(() => {
        if (hasPatientDonorSearchRun && !document.hidden) {
          searchPatientDonors(null, true);
        }
      }, 15000);
      window.setInterval(() => {
        if (hasPatientLiveAvailabilitySearchRun && !document.hidden) {
          searchPatientLiveDonors();
        }
      }, 15000);
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

document.getElementById("availabilityToggle")?.addEventListener("click", () => {
  saveDonorAvailability("available");
});

function openUnavailabilityDialog() {
  document.getElementById("unavailabilityMessage").textContent = "";
  document.getElementById("unavailabilityForm").reset();
  const dialog = document.getElementById("unavailabilityDialog");
  const reason = document.querySelector(
    `input[name="unavailabilityReason"][value="${document.getElementById("availabilityStatus").dataset.reason || ""}"]`
  );
  if (reason) reason.checked = true;
  document.getElementById("reportedDonationDateField").hidden =
    Boolean(verifiedDonationDate) || Boolean(pendingDonationReport);
  document.getElementById("verifiedDonationDateMessage").hidden =
    !verifiedDonationDate || Boolean(pendingDonationReport);
  if (pendingDonationReport) {
    document.getElementById("unavailabilityMessage").textContent =
      `Your reported donation date (${pendingDonationReport.donation_date}) is awaiting authorized verification.`;
  }
  dialog.showModal();
}

document.getElementById("notAvailableButton")?.addEventListener("click", openUnavailabilityDialog);

document.querySelectorAll('input[name="unavailabilityReason"]').forEach(input => {
  input.addEventListener("change", event => {
    const isDonationReason = event.currentTarget.value === "recently_donated";
    document.getElementById("reportedDonationDateField").hidden =
      !isDonationReason || Boolean(verifiedDonationDate) || Boolean(pendingDonationReport);
  });
});

document.getElementById("cancelUnavailability")?.addEventListener("click", () => {
  document.getElementById("unavailabilityDialog").close();
});

document.getElementById("unavailabilityForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const reason = form.elements.unavailabilityReason.value;
  const donationDateInput = document.getElementById("reportedDonationDate");
  const reportedDonationDate = reason === "recently_donated" && !verifiedDonationDate && !pendingDonationReport
    ? donationDateInput.value
    : "";
  if (reason === "recently_donated" && !verifiedDonationDate && !pendingDonationReport &&
      !reportedDonationDate) {
    donationDateInput.setCustomValidity("Enter the last donation date so authorized staff can verify it.");
    form.reportValidity();
    donationDateInput.setCustomValidity("");
    return;
  }
  const saved = await saveDonorAvailability("not_available", {
    mode: "unavailable",
    unavailabilityReason: reason,
    reportedDonationDate
  });
  if (saved) document.getElementById("unavailabilityDialog").close();
});

window.addEventListener("storage", event => {
  if (event.key === "lifedrop-availability-updated" &&
      window.location.pathname.includes("patient-dashboard") &&
      (hasPatientDonorSearchRun || hasPatientLiveAvailabilitySearchRun) &&
      !document.hidden) {
    if (hasPatientDonorSearchRun) searchPatientDonors(null, true);
    if (hasPatientLiveAvailabilitySearchRun) searchPatientLiveDonors();
  }
});

loadDashboard();
