(() => {
  "use strict";

  const loginPanel = document.getElementById("loginPanel");
  const dashboard = document.getElementById("dashboard");
  const loginForm = document.getElementById("loginForm");
  const loginMessage = document.getElementById("loginMessage");
  const refreshStatus = document.getElementById("refreshStatus");
  let isRefreshing = false;
  let dashboardData = null;

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
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

  function setSignedIn(signedIn) {
    loginPanel.hidden = signedIn;
    dashboard.hidden = !signedIn;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }

  function normalizeAvailabilityValue(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (normalized === "available") return "available";
    if (normalized === "expired") return "expired";
    if (["unavailable", "not_available"].includes(normalized)) return "unavailable";
    return "unconfirmed";
  }

  function getDonorAvailabilityStatus(donor) {
    const status = normalizeAvailabilityValue(
      donor.availability_status_code ?? donor.availability_status
    );
    const confirmedAt = Date.parse(donor.last_confirmed_at);
    if (status === "expired") {
      return Number.isFinite(confirmedAt) ? "expired" : "unconfirmed";
    }
    if (status === "available") {
      const expiresAt = Date.parse(donor.available_until);
      const availableFlag = donor.is_available === undefined ||
        donor.is_available === true ||
        donor.is_available === 1 ||
        donor.is_available === "1";
      if (donor.availability_mode === "selected_dates") {
        return Number.isFinite(confirmedAt) && availableFlag
          ? "available"
          : "unconfirmed";
      }
      return Number.isFinite(confirmedAt) &&
        Number.isFinite(expiresAt) &&
        expiresAt > Date.now() &&
        availableFlag
        ? "available"
        : "unconfirmed";
    }
    if (status === "unavailable" && Number.isFinite(confirmedAt)) {
      return "unavailable";
    }
    return "unconfirmed";
  }

  function availabilityLabel(status) {
    if (status === "available") return "Available";
    if (status === "unavailable") return "Not Available";
    if (status === "expired") return "Expired";
    return "Unconfirmed";
  }

  function addRow(tbody, values, emptyMessage) {
    if (values.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = tbody.closest("table").querySelectorAll("thead th").length;
      cell.textContent = emptyMessage;
      row.append(cell);
      tbody.replaceChildren(row);
      return;
    }
    const rows = values.map(valuesForRow => {
      const row = document.createElement("tr");
      valuesForRow.forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        row.append(cell);
      });
      return row;
    });
    tbody.replaceChildren(...rows);
  }

  function renderDonors() {
    const donors = dashboardData.donors;
    const search = document.getElementById("donorSearch").value.trim().toLowerCase();
    const bloodGroup = document.getElementById("donorBloodFilter").value;
    const availability = normalizeAvailabilityValue(
      document.getElementById("donorAvailabilityFilter").value
    );
    const filterByAvailability = document.getElementById("donorAvailabilityFilter").value !== "";
    const filtered = donors.filter(donor => {
      const donorStatus = getDonorAvailabilityStatus(donor);
      const searchable = [
        donor.full_name, donor.username, donor.phone, donor.blood_group,
        donor.city, donor.place, donor.state, donor.email
      ].join(" ").toLowerCase();
      return (!search || searchable.includes(search)) &&
        (!bloodGroup || donor.blood_group === bloodGroup) &&
        (!filterByAvailability || donorStatus === availability);
    });
    document.getElementById("donorResultCount").textContent = `Showing ${filtered.length} of ${donors.length}`;
    const emptyMessage = donors.length === 0
      ? "No donor accounts are registered."
      : "No donors match the selected filters.";
    addRow(document.getElementById("donorRows"), filtered.map(donor => [
      donor.full_name,
      donor.username || "Legacy account",
      donor.phone,
      donor.blood_group,
      donor.city,
      donor.place,
      availabilityLabel(getDonorAvailabilityStatus(donor)),
      formatDate(donor.available_until),
      formatDate(donor.last_confirmed_at),
      donor.email,
      donor.last_donation_date,
      formatDate(donor.registered_at),
      donor.availability_dates || "—"
    ]), emptyMessage);
  }

  function renderPatients() {
    const patients = dashboardData.patients;
    const search = document.getElementById("patientSearch").value.trim().toLowerCase();
    const bloodGroup = document.getElementById("patientBloodFilter").value;
    const urgency = document.getElementById("patientUrgencyFilter").value;
    const status = document.getElementById("patientStatusFilter").value;
    const filtered = patients.filter(patient => {
      const searchable = [
        patient.full_name, patient.username, patient.phone, patient.blood_group,
        patient.city, patient.area, patient.state, patient.email, patient.hospital_name
      ].join(" ").toLowerCase();
      return (!search || searchable.includes(search)) &&
        (!bloodGroup || patient.blood_group === bloodGroup) &&
        (!urgency || patient.urgency === urgency) &&
        (!status || patient.request_status === status);
    });
    document.getElementById("patientResultCount").textContent = `Showing ${filtered.length} of ${patients.length}`;
    addRow(document.getElementById("patientRows"), filtered.map(patient => [
      patient.full_name,
      patient.username || "Legacy account",
      patient.phone,
      patient.blood_group,
      patient.city,
      patient.area,
      patient.urgency,
      patient.request_status,
      patient.email,
      patient.hospital_name
        ? `${patient.hospital_name} / ${patient.units_required ?? "?"} unit(s)`
        : "No linked request",
      formatDate(patient.registered_at)
    ]), "No patient accounts are registered.");
  }

  function renderRequests(data) {
    const allRequests = [
      ...data.patient_requests.map(request => ({
        ...request,
        request_type: "Registration request",
        contact_name: request.patient_name
      })),
      ...data.blood_requests.map(request => ({
        ...request,
        request_type: "Blood request"
      }))
    ].sort((left, right) => Date.parse(right.request_date) - Date.parse(left.request_date));

    addRow(document.getElementById("requestRows"), allRequests.map(request => [
      request.request_type,
      request.contact_name && request.contact_name !== request.patient_name
        ? `${request.contact_name} / ${request.patient_name}`
        : request.patient_name,
      `${request.age ?? "—"} / ${request.gender ?? "—"}`,
      request.blood_group,
      request.hospital_name,
      [request.city, request.area].filter(Boolean).join(", "),
      request.contact_number,
      request.units_required,
      `${request.urgency ?? "—"} / ${request.request_status}`,
      request.request_type === "Blood request"
        ? `${request.donors_notified} notified · ${request.donors_accepted} accepted · ${request.responses_pending} pending · ${request.donors_declined_or_busy} busy/declined · ${request.responses_no_response} no response`
        : "No in-app donor notifications",
      formatDate(request.request_date),
      formatDate(request.needed_at)
    ]), "No patient requests are registered.");
  }

  function renderDashboard(data) {
    dashboardData = data;
    document.getElementById("totalRegistrations").textContent = data.counts.total_registrations;
    document.getElementById("donorCount").textContent = data.counts.donor_count;
    document.getElementById("availableDonorCount").textContent =
      data.counts.available_donor_count;
    document.getElementById("unavailableDonorCount").textContent =
      data.counts.unavailable_donor_count;
    document.getElementById("unconfirmedDonorCount").textContent =
      data.counts.unconfirmed_donor_count;
    document.getElementById("expiredDonorCount").textContent =
      data.counts.expired_donor_count;
    document.getElementById("patientCount").textContent = data.counts.patient_count;
    document.getElementById("requestCount").textContent = data.counts.patient_request_count;
    renderDonors();
    renderPatients();
    renderRequests(data);
    refreshStatus.textContent = `Last updated ${formatDate(data.refreshed_at)}. Live donor availability and dashboard data refresh every 15 seconds.`;
  }

  async function refreshDashboard() {
    if (isRefreshing || dashboard.hidden || document.hidden) return;
    isRefreshing = true;
    try {
      const data = await requestJson("/api/admin/dashboard");
      renderDashboard(data);
    } catch (error) {
      if (error.status === 401) {
        setSignedIn(false);
        loginMessage.textContent = "Your admin session expired. Please log in again.";
      } else {
        refreshStatus.textContent = error.message;
        if (!dashboardData) {
          addRow(document.getElementById("donorRows"), [], "Could not load donor records.");
          addRow(document.getElementById("patientRows"), [], "Could not load patient records.");
          addRow(document.getElementById("requestRows"), [], "Could not load patient requests.");
        }
      }
    } finally {
      isRefreshing = false;
    }
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    const button = loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    loginMessage.textContent = "";
    try {
      await requestJson("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: loginForm.elements.username.value.trim(),
          password: loginForm.elements.password.value
        })
      });
      loginForm.reset();
      setSignedIn(true);
      await refreshDashboard();
    } catch (error) {
      loginMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("refreshButton").addEventListener("click", refreshDashboard);
  document.getElementById("togglePassword").addEventListener("click", event => {
    const button = event.currentTarget;
    const password = document.getElementById("password");
    const isVisible = password.type === "text";
    password.type = isVisible ? "password" : "text";
    button.textContent = isVisible ? "Show" : "Hide";
    button.setAttribute("aria-pressed", String(!isVisible));
  });
  ["donorSearch", "donorBloodFilter", "donorAvailabilityFilter"].forEach(id => {
    const filter = document.getElementById(id);
    ["input", "change"].forEach(eventName => {
      filter.addEventListener(eventName, () => {
        if (dashboardData) renderDonors();
      });
    });
  });
  ["patientSearch", "patientBloodFilter", "patientUrgencyFilter", "patientStatusFilter"].forEach(id => {
    const filter = document.getElementById(id);
    ["input", "change"].forEach(eventName => {
      filter.addEventListener(eventName, () => {
        if (dashboardData) renderPatients();
      });
    });
  });
  document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
      await requestJson("/api/admin/logout", { method: "POST" });
      setSignedIn(false);
      loginMessage.textContent = "You have been logged out.";
    } catch (error) {
      refreshStatus.textContent = error.message;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDashboard();
  });

  window.addEventListener("storage", event => {
    if (event.key === "lifedrop-availability-updated") refreshDashboard();
  });

  requestJson("/api/admin/session")
    .then(() => {
      setSignedIn(true);
      return refreshDashboard();
    })
    .catch(error => {
      setSignedIn(false);
      if (error.status !== 401 && error.status !== 503) loginMessage.textContent = error.message;
      if (error.status === 503) loginMessage.textContent = error.message;
    });

  window.setInterval(refreshDashboard, 15000);
})();
