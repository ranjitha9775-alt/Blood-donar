"use strict";

let dashboardUser = null;
let selectedAvailabilityDates = [];
let donorAvailabilityIntent = false;
let verifiedDonationDate = null;
let pendingDonationReport = null;
let availabilityDialogAction = "update";
let isPatientDonorSearchRunning = false;
let patientRequestSubmissionInProgress = false;
let hasPatientDonorSearchRun = false;

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

function formatLocalDateTimeInput(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function toUtcIsoDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function initializeAvailabilityWindow() {
  const start = new Date(Date.now() + 2 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  setAvailabilityWindowInputs(start, end);
}

function setAvailabilityWindowInputs(start, end) {
  const startValue = formatLocalDateTimeInput(start);
  const endValue = formatLocalDateTimeInput(end);
  document.getElementById("availabilityStartDate").value = startValue.slice(0, 10);
  document.getElementById("availabilityStartTime").value = startValue.slice(11, 16);
  document.getElementById("availabilityEndDate").value = endValue.slice(0, 10);
  document.getElementById("availabilityEndTime").value = endValue.slice(11, 16);
}

function readAvailabilityWindowInputs() {
  const startDate = document.getElementById("availabilityStartDate").value;
  const startTime = document.getElementById("availabilityStartTime").value;
  const endDate = document.getElementById("availabilityEndDate").value;
  const endTime = document.getElementById("availabilityEndTime").value;
  if (!startDate || !startTime || !endDate || !endTime) return { startsAt: "", endsAt: "" };
  return {
    startsAt: toUtcIsoDateTime(`${startDate}T${startTime}`),
    endsAt: toUtcIsoDateTime(`${endDate}T${endTime}`)
  };
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
  document.getElementById("generalAvailabilityWindow").hidden = useSelectedDates;
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
      row.className = "availability-date-row";
      const label = document.createElement("label");
      label.className = "availability-date-choice";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.status === "available";
      checkbox.setAttribute("aria-label", `Available to donate on ${item.date}`);
      checkbox.addEventListener("change", () => {
        item.status = checkbox.checked ? "available" : "unavailable";
        renderAvailabilityDates();
      });
      label.append(
        checkbox,
        makeTextElement("span", `${item.date} · ${item.status === "available" ? "Available" : "Not available"}`)
      );
      const remove = makeTextElement("button", "Remove date");
      remove.type = "button";
      remove.className = "button-secondary";
      remove.addEventListener("click", () => {
        selectedAvailabilityDates = selectedAvailabilityDates.filter(date => date.date !== item.date);
        renderAvailabilityDates();
      });
      row.append(label, remove);
      return row;
    });
  container.replaceChildren(...rows);
}

async function loadDonorAvailability() {
  const message = document.getElementById("availabilityMessage");
  try {
    const data = await requestJson("/api/availability/status");
    verifiedDonationDate = data.verified_last_donation_date || null;
    pendingDonationReport = data.pending_donation_report || null;
    const status = document.getElementById("availabilityStatus");
    donorAvailabilityIntent = data.availability_status === "available" &&
      ["Available", "Scheduled"].includes(data.status);
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
    status.dataset.reason = data.unavailability_reason || "";
    document.getElementById("lastConfirmedAt").textContent =
      formatDashboardDate(data.last_confirmed_at);
    const toggle = document.getElementById("availabilityToggle");
    toggle.classList.toggle("available", donorAvailabilityIntent);
    toggle.setAttribute("aria-pressed", String(donorAvailabilityIntent));
    toggle.querySelector(".toggle-icon").textContent = donorAvailabilityIntent ? "✓" : "×";
    toggle.querySelector(".toggle-label").textContent = donorAvailabilityIntent ? "Currently Available" : "Available";
    document.getElementById("availabilityCurrentMessage").textContent =
      data.status === "Available" ? "🟢 Currently Available" : "⚪ Currently Not Available";
    const savedDates = Array.isArray(data.selected_dates) ? data.selected_dates : [];
    const availableDateCount = savedDates.filter(item => item.status === "available").length;
    const unavailableDateCount = savedDates.length - availableDateCount;
    document.getElementById("availabilityWindowSummary").textContent =
      data.status === "Not Available" && data.expected_available_at
        ? `Expected available from ${formatDashboardDate(data.expected_available_at)}. You must confirm availability again; this date will not reactivate your status.`
        : data.availability_starts_at && data.available_until
          ? `Available from ${formatDashboardDate(data.availability_starts_at)} until ${formatDashboardDate(data.available_until)}.`
          : data.availability_mode === "selected_dates" && savedDates.length
            ? `Selected-date schedule: ${availableDateCount} available date(s) and ${unavailableDateCount} marked unavailable.`
            : savedDates.length
              ? `Saved selected-date schedule: ${availableDateCount} available date(s) and ${unavailableDateCount} marked unavailable. Current mode: general availability.`
              : data.availability_mode === "selected_dates"
                ? "No future availability dates have been saved."
                : "Availability dates have not been set.";
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
    document.getElementById("temporarilyUnavailable").setAttribute(
      "aria-pressed",
      String(data.status === "Temporarily Unavailable")
    );
    document.getElementById("publicContactConsent").checked = data.public_contact_consent;
    document.getElementById("publicIdentityConsent").checked = data.public_identity_consent;
    document.getElementById("emergencyResponseConsent").checked = data.emergency_response_consent;
    document.getElementById("availabilityMode").value =
      data.availability_mode === "selected_dates" ? "selected_dates" : "general";
    if (data.availability_starts_at && data.available_until) {
      setAvailabilityWindowInputs(new Date(data.availability_starts_at), new Date(data.available_until));
    } else {
      initializeAvailabilityWindow();
    }
    selectedAvailabilityDates = Array.isArray(data.selected_dates)
      ? data.selected_dates.map(item => ({ date: item.date, status: item.status }))
      : [];
    renderAvailabilityDates();
    message.textContent = data.status === "Scheduled"
      ? `Your availability is scheduled from ${formatDashboardDate(data.availability_starts_at)} until ${formatDashboardDate(data.available_until)}. It will not appear in searches before it starts.`
      : !data.eligible_for_matching
      ? `Availability is recorded, but matching requires the next eligible date and a current professional medical review. Next interval date: ${data.next_eligible_date || "not calculated"}.`
      : data.available_until
      ? `Confirmation expiry: ${formatDashboardDate(data.available_until)}.`
      : data.availability_mode === "selected_dates"
        ? "Your schedule applies only to the selected dates shown above."
      : data.last_confirmed_at
        ? "You are not currently listed as available."
        : "You have not confirmed availability yet.";
    const matchingBlockers = [];
    if (data.status === "Scheduled") {
      matchingBlockers.push(`wait until your scheduled start time (${formatDashboardDate(data.availability_starts_at)})`);
    } else if (data.status !== "Available") {
      matchingBlockers.push("confirm Available with a current confirmation");
    }
    if (!data.eligible_for_matching) matchingBlockers.push("complete screening and receive current qualified-staff eligibility approval");
    if (!data.public_contact_consent) matchingBlockers.push("enable sharing of blood group and city/state in Live Donor Search");
    if (data.availability_mode === "selected_dates") {
      matchingBlockers.push("patients must select one of your saved available dates in their search");
      if (!data.selected_dates.some(item => item.status === "available")) {
        matchingBlockers.push("save at least one future date as Available");
      }
    }
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
    document.getElementById("temporarilyUnavailable")
  ];
  const message = document.getElementById("availabilityMessage");
  buttons.push(document.getElementById("saveAvailabilityDates"));
  buttons.push(document.getElementById("updateAvailabilityButton"));
  buttons.push(document.getElementById("saveAvailabilityWindow"));
  buttons.forEach(button => { if (button) button.disabled = true; });
  message.textContent = "Saving your availability…";
  const mode = options.mode || (["not_available", "temporarily_unavailable"].includes(status)
    ? "unavailable"
    : document.getElementById("availabilityMode").value);
  if (status === "available" && mode === "selected_dates" &&
      !selectedAvailabilityDates.some(item => item.status === "available")) {
    message.textContent = "Add at least one future date marked Available before confirming selected-date availability.";
    buttons.forEach(button => { if (button) button.disabled = false; });
    return;
  }
  const { startsAt, endsAt } = mode === "general" ? readAvailabilityWindowInputs() : {};
  const needsWindow = mode === "general" &&
    (status === "available" || options.includeWindow === true);
  if (needsWindow && (!startsAt || !endsAt || Date.parse(startsAt) <= Date.now() ||
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      Date.parse(endsAt) - Date.parse(startsAt) > 366 * 24 * 60 * 60 * 1000)) {
    const validationMessage = options.includeWindow
      ? document.getElementById("availabilityWindowMessage")
      : message;
    validationMessage.textContent = "Choose a future start and a later end time within 366 days. Times are stored in UTC.";
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
        mode,
        ...(mode === "general" && startsAt && endsAt ? { starts_at: startsAt, ends_at: endsAt } : {}),
        ...(options.unavailabilityReason ? {
          unavailability_reason: options.unavailabilityReason,
          expected_available_at: options.expectedAvailableAt || null,
          reported_donation_date: options.reportedDonationDate || null
        } : {}),
        selected_dates: mode === "selected_dates" ? selectedAvailabilityDates : []
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
      : result.status === "Scheduled"
      ? `Saved: your availability is scheduled from ${formatDashboardDate(result.availability_starts_at)} until ${formatDashboardDate(result.available_until)} (UTC storage).`
      : result.status === "Available"
      ? mode === "selected_dates"
        ? "Saved: your selected dates are set as available. Your donor status is recorded; matching still requires eligibility and consent."
        : `Saved: your status is Available${result.available_until ? ` until ${formatDashboardDate(result.available_until)}` : ""}. Matching still requires eligibility and consent.`
      : result.status === "Temporarily Unavailable"
        ? "Saved: your status is Temporarily Unavailable. You will stay off matching until you confirm availability again."
        : options.includeWindow
          ? "Saved: your availability dates are updated. Your live status remains Not Available."
          : "Saved: your status is Not Available. You will not appear in available donor search.";
    return true;
  } catch (error) {
    console.error("Donor availability could not be saved:", error);
    const errorTarget = options.unavailabilityReason
      ? document.getElementById("unavailabilityMessage")
      : message;
    errorTarget.textContent = error.message;
    if (options.includeWindow) {
      document.getElementById("availabilityWindowMessage").textContent = error.message;
    }
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
        if (donorResponse.can_select && !request.has_selected_donor) {
          const selectButton = makeTextElement(
            "button",
            donorResponse.patient_selected ? "Selected for coordination" : "Confirm donor for coordination"
          );
          selectButton.type = "button";
          selectButton.disabled = donorResponse.patient_selected;
          selectButton.addEventListener("click", () =>
            confirmPatientDonor(request.request_id, donorResponse.donor_response_id, selectButton)
          );
          responseLine.append(selectButton);
        } else if (donorResponse.can_select && donorResponse.patient_selected) {
          responseLine.append(makeTextElement("p", "This donor is selected for coordination."));
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
  const message = document.getElementById("patientResponsesMessage");
  message.textContent = "Saving your selection…";
  try {
    const result = await requestJson(
      `/api/my-emergency-requests/${encodeURIComponent(requestId)}/confirm-donor`,
      {
        method: "POST",
        body: JSON.stringify({ donor_user_id: donorUserId })
      }
    );
    message.textContent = result.message;
    await loadPatientResponses();
  } catch (error) {
    console.error("Patient donor selection could not be saved:", error);
    message.textContent = error.message;
    await loadPatientResponses();
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
        makeTextElement("p", "Contact details are not public. Submit a request for this donor; their phone is shown only after they accept and explicitly consent to share it."),
        makeTextElement("p", `Last confirmed: ${formatDashboardDate(donor.last_confirmed_at)} · Available until ${formatDashboardDate(donor.available_until)}.`)
      );
      const action = makeTextElement("button", "Contact Donor");
      action.type = "button";
      action.addEventListener("click", () => {
        if (!donor.emergency_matching_enabled) {
          message.textContent =
            `${donor.display_name || "This donor"} has not opted into emergency request notifications. No request was sent; contact details are not public.`;
          return;
        }
        document.getElementById("patientRequestCard").hidden = false;
        document.getElementById("targetDonorUserId").value = donor.contact_token;
        document.getElementById("contactTargetState").value = donor.state;
        document.getElementById("contactTargetSummary").hidden = false;
        document.getElementById("contactTargetSummary").textContent =
          `This request will be sent only to ${donor.display_name || "the selected donor"}. Their contact details remain private unless they accept and consent to share.`;
        document.getElementById("requestBlood").value = donor.blood_group;
        document.getElementById("requestCity").value = donor.city;
        document.getElementById("requestDistrict").value = donor.city;
        document.getElementById("requestUnits").value = "1";
        document.getElementById("requestUrgency").value = "Urgent";
        document.getElementById("requestMatchDonors").checked = true;
        if (requiredDate) {
          const neededAt = document.getElementById("requestNeededAt");
          const time = neededAt.value.split("T")[1] || "10:00";
          neededAt.value = `${requiredDate}T${time}`;
        }
        document.getElementById("patientRequestCard").scrollIntoView({ behavior: "smooth" });
        document.getElementById("requestHospitalName").focus();
      });
      card.append(action);
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
            : event.event_type === "request_status_self_reported"
              ? `Patient self-reported status: ${event.new_status}`
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
      document.getElementById("patientEmergencyRequestForm").addEventListener("submit", submitPatientEmergencyRequest);
      document.getElementById("searchLocalInventory").addEventListener("click", searchLocalBloodInventory);
      document.getElementById("patientRequestStatusCard").hidden = false;
      document.getElementById("patientResponsesCard").hidden = false;
      await loadPatientResponses();
      await loadPatientRequestStatuses();
      if (new URLSearchParams(window.location.search).get("open") === "request") {
        const requestCard = document.getElementById("patientRequestCard");
        requestCard.hidden = false;
        document.getElementById("welcome").textContent =
          `Welcome, ${user.full_name}. Complete the emergency request form below.`;
        window.requestAnimationFrame(() => {
          requestCard.scrollIntoView({ block: "start", behavior: "smooth" });
          document.getElementById("requestHospitalName").focus({ preventScroll: true });
        });
      }
      window.setInterval(loadPatientResponses, 30000);
      window.setInterval(loadPatientRequestStatuses, 30000);
      window.setInterval(() => {
        if (hasPatientDonorSearchRun && !document.hidden) {
          searchPatientDonors(null, true);
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
  availabilityDialogAction = "activate";
  const startsAt = document.getElementById("availabilityStartDate").value;
  const endsAt = document.getElementById("availabilityEndDate").value;
  const hasUsableSavedWindow = startsAt && endsAt &&
    Date.parse(`${startsAt}T${document.getElementById("availabilityStartTime").value}`) > Date.now() &&
    Date.parse(`${endsAt}T${document.getElementById("availabilityEndTime").value}`) >
      Date.parse(`${startsAt}T${document.getElementById("availabilityStartTime").value}`);
  if (document.getElementById("availabilityMode").value === "general" && !hasUsableSavedWindow) {
    initializeAvailabilityWindow();
  }
  document.getElementById("availabilityWindowMessage").textContent = "";
  document.getElementById("availabilityDialog").showModal();
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

document.getElementById("temporarilyUnavailable")?.addEventListener("click", () => {
  saveDonorAvailability("temporarily_unavailable");
});

document.getElementById("updateAvailabilityButton")?.addEventListener("click", () => {
  const dialog = document.getElementById("availabilityDialog");
  availabilityDialogAction = "update";
  if (!document.getElementById("availabilityStartDate").value) initializeAvailabilityWindow();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  document.getElementById("availabilityStartDate").min = today;
  document.getElementById("availabilityEndDate").min =
    document.getElementById("availabilityStartDate").value || today;
  document.getElementById("availabilityWindowMessage").textContent = "";
  dialog.showModal();
});

document.getElementById("availabilityStartDate")?.addEventListener("change", event => {
  document.getElementById("availabilityEndDate").min = event.currentTarget.value;
});

document.getElementById("cancelAvailabilityUpdate")?.addEventListener("click", () => {
  document.getElementById("availabilityDialog").close();
});

document.getElementById("availabilityWindowForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const message = document.getElementById("availabilityWindowMessage");
  const { startsAt, endsAt } = readAvailabilityWindowInputs();
  if (!startsAt || !endsAt || Date.parse(startsAt) <= Date.now() ||
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      Date.parse(endsAt) - Date.parse(startsAt) > 366 * 24 * 60 * 60 * 1000) {
    message.textContent = "Choose a future start and a later end time within 366 days.";
    return;
  }
  document.getElementById("availabilityMode").value = "general";
  renderAvailabilityDates();
  const mode = "general";
  const statusToSave = availabilityDialogAction === "activate" || donorAvailabilityIntent
    ? "available"
    : "not_available";
  const saved = await saveDonorAvailability(statusToSave, {
    mode,
    includeWindow: mode === "general"
  });
  if (saved) document.getElementById("availabilityDialog").close();
});

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
  const expectedDate = document.getElementById("expectedAvailableDate").value;
  const expectedTime = document.getElementById("expectedAvailableTime").value;
  if (Boolean(expectedDate) !== Boolean(expectedTime)) {
    document.getElementById("unavailabilityMessage").textContent =
      "Enter both the expected available-from date and time, or leave both empty.";
    return;
  }
  let expectedAvailableAt = null;
  if (expectedDate && expectedTime) {
    expectedAvailableAt = toUtcIsoDateTime(`${expectedDate}T${expectedTime}`);
    if (!expectedAvailableAt || Date.parse(expectedAvailableAt) <= Date.now()) {
      document.getElementById("unavailabilityMessage").textContent =
        "Expected available-from date and time must be in the future.";
      return;
    }
  }
  const saved = await saveDonorAvailability("not_available", {
    mode: "unavailable",
    unavailabilityReason: reason,
    expectedAvailableAt,
    reportedDonationDate
  });
  if (saved) document.getElementById("unavailabilityDialog").close();
});

window.addEventListener("storage", event => {
  if (event.key === "lifedrop-availability-updated" &&
      window.location.pathname.includes("patient-dashboard") &&
      hasPatientDonorSearchRun &&
      !document.hidden) {
    searchPatientDonors(null, true);
  }
});

document.getElementById("availabilityMode")?.addEventListener("change", renderAvailabilityDates);
function addSelectedAvailabilityDate({ allowDuplicate = false } = {}) {
  const input = document.getElementById("availabilityDate");
  const date = input.value;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (!date || date <= today) {
    document.getElementById("availabilityMessage").textContent =
      "Choose a date after today.";
    return false;
  }
  if (selectedAvailabilityDates.some(item => item.date === date)) {
    document.getElementById("availabilityMessage").textContent =
      "That date is already in your list.";
    if (!allowDuplicate) return false;
  } else {
    selectedAvailabilityDates.push({ date, status: "available" });
  }
  input.value = "";
  document.getElementById("availabilityMessage").textContent =
    allowDuplicate
      ? "Saving your selected dates…"
      : "Date added. Save your selected dates to update your availability.";
  renderAvailabilityDates();
  return true;
}

document.getElementById("addAvailabilityDate")?.addEventListener("click", () => {
  addSelectedAvailabilityDate();
});

document.getElementById("saveAvailabilityDates")?.addEventListener("click", () => {
  const dateInput = document.getElementById("availabilityDate");
  if (dateInput.value && !addSelectedAvailabilityDate({ allowDuplicate: true })) return;
  const hasAvailableDate = selectedAvailabilityDates.some(item => item.status === "available");
  saveDonorAvailability(hasAvailableDate ? "available" : "not_available");
});

loadDashboard();
