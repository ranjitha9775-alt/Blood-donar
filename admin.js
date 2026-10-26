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
    if (normalized === "temporarily_unavailable") return "temporarily_unavailable";
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
    if (status === "temporarily_unavailable" && Number.isFinite(confirmedAt)) {
      return "temporarily_unavailable";
    }
    return "unconfirmed";
  }

  function availabilityLabel(status) {
    if (status === "available") return "Available";
    if (status === "unavailable") return "Not Available";
    if (status === "temporarily_unavailable") return "Temporarily Unavailable";
    if (status === "expired") return "Expired";
    return "Unconfirmed";
  }

  function addRow(tbody, values, emptyMessage, cellClasses = []) {
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
      valuesForRow.forEach((value, index) => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        const className = typeof cellClasses[index] === "function"
          ? cellClasses[index](valuesForRow)
          : cellClasses[index];
        if (className) cell.className = className;
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
    const city = document.getElementById("donorCityFilter").value.trim().toLowerCase();
    const eligibility = document.getElementById("donorEligibilityFilter").value;
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
        (!city || String(donor.city || "").toLowerCase().includes(city)) &&
        (!eligibility || donor.eligibility_status === eligibility) &&
        (!bloodGroup || donor.blood_group === bloodGroup) &&
        (!filterByAvailability || donorStatus === availability);
    });
    document.getElementById("donorResultCount").textContent = `Showing ${filtered.length} of ${donors.length}`;
    const emptyMessage = donors.length === 0
      ? "No donor accounts are registered."
      : "No donors match the selected filters.";
    addRow(document.getElementById("donorRows"), filtered.map(donor => {
      const status = getDonorAvailabilityStatus(donor);
      const formattedDates = donor.availability_dates
        ? donor.availability_dates
          .replace(/, /g, "\n")
          .replace(/: available\b/g, ": Available")
          .replace(/: unavailable\b/g, ": Not available")
        : "—";
      return [
        donor.full_name,
        donor.username || "Legacy account",
        donor.phone,
        donor.blood_group,
        donor.city,
        donor.place,
        availabilityLabel(status),
        formatDate(donor.available_until),
        formatDate(donor.last_confirmed_at),
        donor.email,
        donor.last_donation_date,
        donor.next_eligible_date,
        String(donor.eligibility_status || "awaiting_review").replaceAll("_", " "),
        donor.eligibility_review_decision
          ? `${donor.eligibility_review_decision} by ${donor.eligibility_reviewed_by || "authorized staff"} · ${formatDate(donor.eligibility_reviewed_at)}`
          : "No authorized review",
        formatDate(donor.registered_at),
        formattedDates
      ];
    }), emptyMessage, [
      "", "", "", "", "", "",
      values => {
        const donor = filtered.find(item =>
          item.full_name === values[0] &&
          (item.username || "Legacy account") === values[1]
        );
        const status = getDonorAvailabilityStatus(donor || {});
        return `availability-badge ${status === "unavailable" ? "not-available" : status}`;
      },
      "", "", "", "", "", "", "", "", "availability-dates"
    ]);
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

  async function refreshDonations() {
    const { donors, donations, corrections } = await requestJson("/api/admin/donations");
    const donorSelect = document.getElementById("donationDonor");
    const selectedDonor = donorSelect.value;
    donorSelect.replaceChildren(...donors.map(donor => {
      const option = document.createElement("option");
      option.value = donor.donor_user_id;
      option.textContent = `${donor.full_name} · ${donor.blood_group}`;
      return option;
    }));
    if (donors.some(donor => String(donor.donor_user_id) === selectedDonor)) {
      donorSelect.value = selectedDonor;
    }
    addRow(document.getElementById("donationRows"), donations.map(donation => [
      donation.full_name,
      donation.blood_group,
      donation.donation_date,
      donation.eligibility_interval_months,
      donation.next_eligible_date,
      donation.verification_status,
      `${donation.recorded_by_admin_username} / ${donation.verified_by_admin_username}`,
      formatDate(donation.verified_at),
      donation.notes,
      ""
    ]), "No completed donations have been recorded.");
    [...document.getElementById("donationRows").rows].forEach((row, index) => {
      const donation = donations[index];
      const cell = row.lastElementChild;
      if (!donation || !cell || donation.verification_status !== "verified") return;
      const button = document.createElement("button");
      button.className = "button button-secondary";
      button.type = "button";
      button.textContent = "Correct date";
      button.addEventListener("click", async () => {
        const donationDate = window.prompt("Corrected donation date (YYYY-MM-DD):", donation.donation_date);
        if (!donationDate) return;
        const correctionNote = window.prompt("Reason for correction (required):", "");
        if (!correctionNote) return;
        try {
          const result = await requestJson(`/api/admin/donations/${donation.donation_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ donation_date: donationDate.trim(), correction_note: correctionNote.trim() })
          });
          document.getElementById("donationMessage").textContent = result.message;
          await refreshDonations();
          await refreshDashboard();
        } catch (error) {
          document.getElementById("donationMessage").textContent = error.message;
        }
      });
      cell.append(button);
    });
    addRow(document.getElementById("donationCorrectionRows"), corrections.map(correction => [
      correction.full_name,
      String(correction.donation_id),
      correction.previous_donation_date,
      correction.corrected_donation_date,
      correction.corrected_by,
      formatDate(correction.corrected_at),
      correction.correction_note
    ]), "No donation date corrections have been recorded.");
  }

  async function refreshEligibilityRequests() {
    const { requests, reviews } = await requestJson("/api/admin/eligibility-requests");
    const rows = requests.map(request => [
      request.full_name,
      request.blood_group,
      request.last_donation_date,
      request.next_review_date,
      formatDate(request.requested_at),
      request.request_status,
      request.latest_staff_decision || "No clinical decision",
      request.reviewed_by ? `${request.reviewed_by} · ${formatDate(request.reviewed_at)}` : "",
      request.instructions || "",
      ""
    ]);
    addRow(document.getElementById("eligibilityRequestRows"), rows, "No eligibility review requests have been submitted.");
    [...document.getElementById("eligibilityRequestRows").rows].forEach((row, index) => {
      const request = requests[index];
      const cell = row.lastElementChild;
      if (!request || request.request_status !== "pending" || !cell) return;
      for (const [decision, label] of [
        ["approved", "Accept for staff review"],
        ["rejected", "Reject request"]
      ]) {
        const button = document.createElement("button");
        button.className = decision === "approved" ? "button" : "button button-secondary";
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", async () => {
          const instructions = decision === "rejected"
            ? window.prompt("Instructions for the donor (required):", "")
            : window.prompt("Optional note for the donor:", "");
          if (instructions === null) return;
          if (decision === "rejected" && !instructions.trim()) {
            document.getElementById("eligibilityRequestMessage").textContent = "A rejection requires instructions for the donor.";
            return;
          }
          try {
            const result = await requestJson(`/api/admin/eligibility-requests/${request.request_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision, instructions: instructions.trim() })
            });
            document.getElementById("eligibilityRequestMessage").textContent = result.message;
            await refreshEligibilityRequests();
            await refreshDashboard();
          } catch (error) {
            document.getElementById("eligibilityRequestMessage").textContent = error.message;
          }
        });
        cell.append(button, " ");
      }
    });
    document.getElementById("pendingEligibilityRequestsCount").textContent =
      requests.filter(request => request.request_status === "pending").length;
    addRow(document.getElementById("eligibilityDecisionRows"), reviews.map(review => [
      review.full_name,
      review.blood_group,
      review.decision === "eligible" ? "Eligibility Confirmed" : "Temporarily Ineligible",
      review.reviewed_by,
      formatDate(review.reviewed_at),
      review.notes
    ]), "No authorized eligibility decisions have been recorded.");
  }

  async function refreshBloodStock() {
    const data = await requestJson("/api/admin/blood-stock");
    const bankSelect = document.getElementById("stockBankSelect");
    const currentBank = bankSelect.value;
    bankSelect.replaceChildren(...data.banks.map(bank => {
      const option = document.createElement("option");
      option.value = bank.blood_bank_id;
      option.textContent = `${bank.bank_name} · ${[bank.city, bank.state].filter(Boolean).join(", ")} · ${bank.verification_status}`;
      return option;
    }));
    if (data.banks.some(bank => String(bank.blood_bank_id) === currentBank)) bankSelect.value = currentBank;
    const thresholds = new Map(data.thresholds.map(item => [
      `${item.blood_bank_id}:${item.blood_group}:${item.component}`,
      item.low_stock_threshold
    ]));
    const updateThresholdInput = () => {
      const key = `${bankSelect.value}:${document.getElementById("stockGroupSelect").value}:${document.getElementById("stockComponentSelect").value}`;
      document.getElementById("stockThresholdInput").value = thresholds.get(key) ?? 0;
    };
    updateThresholdInput();
    addRow(document.getElementById("bloodBankRows"), data.banks.map(bank => [
      bank.bank_name,
      [bank.city, bank.district, bank.state].filter(Boolean).join(", "),
      bank.verification_status,
      bank.is_active ? "Active" : "Inactive",
      `${bank.update_submitted_today ? "Updated today (UTC)" : "No update today (UTC)"} · Last: ${formatDate(bank.last_update_at)} · Pending: ${bank.pending_stock_count} · Rejected: ${bank.rejected_stock_count}`,
      bank.verification_status === "verified" ? "Verified" : bank.verification_status === "pending" ? "Pending review" : "Rejected"
    ]), "No blood banks are registered.");
    addRow(document.getElementById("adminStockRows"), data.stocks.map(stock => [
      stock.bank_name,
      [stock.city, stock.district, stock.state].filter(Boolean).join(", "),
      stock.blood_group,
      stock.component.replaceAll("_", " "),
      stock.physical_units,
      stock.reserved_units,
      stock.issued_units,
      stock.discarded_units,
      stock.available_units,
      stock.status,
      `${stock.stock_date || "No stock date"} · ${formatDate(stock.last_updated)}`,
      stock.verification_status,
      ""
    ]), "No stock updates have been recorded.");
    [...document.getElementById("adminStockRows").rows].forEach((row, index) => {
      const stock = data.stocks[index];
      const cell = row.lastElementChild;
      if (!stock || !cell) return;
      cell.replaceChildren();
      if (stock.verification_status === "verified") {
        cell.textContent = "Verified";
        return;
      }
      for (const [status, label] of [["verified", "Verify"], ["rejected", "Reject"]]) {
        const action = document.createElement("button");
        action.className = status === "verified" ? "button" : "button button-secondary";
        action.type = "button";
        action.textContent = label;
        action.addEventListener("click", async () => {
          try {
            await requestJson(`/api/admin/blood-stock/${stock.stock_id}/verification`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ verification_status: status })
            });
            await refreshBloodStock();
          } catch (error) {
            document.getElementById("stockAdminMessage").textContent = error.message;
          }
        });
        cell.append(action, " ");
      }
    });
    const tbody = document.getElementById("bloodBankRows");
    [...tbody.rows].forEach((row, index) => {
      const bank = data.banks[index];
      const cell = row.lastElementChild;
      if (!bank) return;
      cell.replaceChildren();
      if (bank.verification_status === "verified") {
        cell.append(document.createTextNode("Verified"));
        const revoke = document.createElement("button");
        revoke.className = "button button-secondary";
        revoke.type = "button";
        revoke.textContent = "Suspend";
        revoke.addEventListener("click", () => updateBankVerification(bank.blood_bank_id, "rejected"));
        cell.append(" ", revoke);
      } else {
        for (const [status, label] of [["verified", "Verify"], ["rejected", "Reject"]]) {
          const action = document.createElement("button");
          action.className = status === "verified" ? "button" : "button button-secondary";
          action.type = "button";
          action.textContent = label;
          action.addEventListener("click", () => updateBankVerification(bank.blood_bank_id, status));
          cell.append(action, " ");
        }
      }
    });
    const currentKey = `${bankSelect.value}:${document.getElementById("stockGroupSelect").value}:${document.getElementById("stockComponentSelect").value}`;
    if (thresholds.has(currentKey)) document.getElementById("stockThresholdInput").value = thresholds.get(currentKey);
    document.getElementById("stockAlertRows").replaceChildren(...(data.alerts.length
      ? data.alerts.map(alert => {
        const row = document.createElement("p");
        row.className = "status-line";
        row.textContent = `${alert.bank_name} · ${alert.blood_group || "All groups"} ${alert.component || ""} · ${alert.alert_type}: ${alert.message}`;
        return row;
      }) : [Object.assign(document.createElement("p"), { textContent: "No active stock alerts." })]));
    document.getElementById("stockThresholdHistory").replaceChildren(...(data.threshold_history.length
      ? data.threshold_history.map(item => {
        const row = document.createElement("p");
        row.className = "status-line";
        row.textContent = `${item.bank_name} · ${item.blood_group} ${item.component.replaceAll("_", " ")} · ${item.previous_threshold ?? "unset"} → ${item.new_threshold} · ${item.admin_username} · ${formatDate(item.created_at)}`;
        return row;
      }) : [Object.assign(document.createElement("p"), { textContent: "No threshold changes recorded." })]));
    document.getElementById("stockAdminMessage").textContent =
      "Every stock record is fresh only on its UTC stock date. Yesterday’s figures are not shown as current.";
    await refreshBloodBankStaff();
  }

  async function refreshBloodBankStaff() {
    const { staff } = await requestJson("/api/admin/blood-bank-staff");
    const select = document.getElementById("bankStaffAccount");
    select.replaceChildren(...staff.map(account => {
      const option = document.createElement("option");
      option.value = account.user_id;
      option.textContent = `${account.full_name} · ${account.username || account.email}${account.bank_name ? ` · ${account.bank_name}` : " · Unassigned"}`;
      return option;
    }));
    if (!staff.length) {
      select.add(new Option("No blood-bank accounts provisioned", ""));
    }
    document.getElementById("bankStaffRows").replaceChildren(...(staff.length
      ? staff.map(account => {
        const row = document.createElement("p");
        row.className = "status-line";
        row.textContent = `${account.full_name} · ${account.username || account.email} · ${account.bank_name || "Not assigned"}`;
        return row;
      })
      : [Object.assign(document.createElement("p"), {
        className: "status-line",
        textContent: "No role=blood_bank accounts are registered. A trusted administrator must provision authorized staff credentials before mapping them here."
      })]));
  }

  async function updateBankVerification(bankId, verificationStatus) {
    const message = document.getElementById("stockAdminMessage");
    try {
      const result = await requestJson(`/api/admin/blood-banks/${bankId}/verification`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification_status: verificationStatus })
      });
      message.textContent = result.message;
      await refreshBloodStock();
    } catch (error) {
      message.textContent = error.message;
    }
  }

  function renderDashboard(data) {
    dashboardData = data;
    document.getElementById("totalRegistrations").textContent = data.counts.total_registrations;
    document.getElementById("donorCount").textContent = data.counts.donor_count;
    document.getElementById("availableDonorCount").textContent =
      data.counts.available_donor_count;
    document.getElementById("unavailableDonorCount").textContent =
      data.counts.unavailable_donor_count;
    document.getElementById("temporarilyUnavailableDonorCount").textContent =
      data.counts.temporarily_unavailable_donor_count;
    document.getElementById("cooldownDonorCount").textContent =
      data.counts.donors_in_cooldown;
    document.getElementById("awaitingEligibilityCount").textContent =
      data.counts.donors_awaiting_eligibility_review;
    document.getElementById("staleAvailabilityCount").textContent =
      data.counts.stale_availability_count;
    document.getElementById("pendingEmergencyRequestCount").textContent =
      data.counts.pending_emergency_requests;
    document.getElementById("unconfirmedDonorCount").textContent =
      data.counts.unconfirmed_donor_count;
    document.getElementById("expiredDonorCount").textContent =
      data.counts.expired_donor_count;
    document.getElementById("patientCount").textContent = data.counts.patient_count;
    document.getElementById("requestCount").textContent = data.counts.patient_request_count;
    document.getElementById("recentVerifiedDonations").replaceChildren(...(data.recent_verified_donations.length
      ? data.recent_verified_donations.map(donation =>
        Object.assign(document.createElement("p"), {
          className: "status-line",
          textContent: `${donation.full_name} · ${donation.blood_group} · ${donation.donation_date} · next review ${donation.next_eligible_date} · verified ${formatDate(donation.verified_at)}`
        })
      )
      : [Object.assign(document.createElement("p"), {
        className: "status-line",
        textContent: "No verified donation records yet."
      })]));
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
      await Promise.all([refreshDonations(), refreshEligibilityRequests(), refreshBloodStock()]);
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
  ["stockBankSelect", "stockGroupSelect", "stockComponentSelect"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
      const bankId = document.getElementById("stockBankSelect").value;
      requestJson("/api/admin/blood-stock").then(data => {
        const item = data.thresholds.find(threshold =>
          String(threshold.blood_bank_id) === bankId &&
          threshold.blood_group === document.getElementById("stockGroupSelect").value &&
          threshold.component === document.getElementById("stockComponentSelect").value
        );
        document.getElementById("stockThresholdInput").value = item?.low_stock_threshold ?? 0;
      }).catch(error => {
        document.getElementById("stockAdminMessage").textContent = error.message;
      });
    });
  });
  document.getElementById("saveStockThreshold").addEventListener("click", async () => {
    const message = document.getElementById("stockAdminMessage");
    const threshold = Number(document.getElementById("stockThresholdInput").value);
    if (!document.getElementById("stockBankSelect").value || !Number.isSafeInteger(threshold) || threshold < 0) {
      message.textContent = "Choose a bank and a non-negative integer threshold.";
      return;
    }
    try {
      const result = await requestJson("/api/admin/blood-stock/thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blood_bank_id: Number(document.getElementById("stockBankSelect").value),
          blood_group: document.getElementById("stockGroupSelect").value,
          component: document.getElementById("stockComponentSelect").value,
          low_stock_threshold: threshold
        })
      });
      message.textContent = result.message;
      await refreshBloodStock();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.getElementById("mapBankStaff").addEventListener("click", async () => {
    const message = document.getElementById("stockAdminMessage");
    const userId = Number(document.getElementById("bankStaffAccount").value);
    const bankId = Number(document.getElementById("stockBankSelect").value);
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(bankId) || bankId < 1) {
      message.textContent = "Select an existing blood-bank account and a bank.";
      return;
    }
    try {
      const result = await requestJson("/api/admin/blood-bank-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, bank_id: bankId })
      });
      message.textContent = result.message;
      await refreshBloodBankStaff();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.getElementById("donationForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("recordDonation");
    const message = document.getElementById("donationMessage");
    if (!form.reportValidity()) return;
    button.disabled = true;
    message.textContent = "Recording the verified donation and eligibility date…";
    try {
      const result = await requestJson(`/api/admin/donors/${form.elements.donor_id.value}/donations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          donation_date: form.elements.donation_date.value,
          notes: form.elements.notes.value.trim()
        })
      });
      message.textContent = `${result.message} Next interval date: ${result.next_eligible_date}.`;
      await Promise.all([refreshDashboard(), refreshDonations()]);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("togglePassword").addEventListener("click", event => {
    const button = event.currentTarget;
    const password = document.getElementById("password");
    const isVisible = password.type === "text";
    password.type = isVisible ? "password" : "text";
    button.textContent = isVisible ? "Show" : "Hide";
    button.setAttribute("aria-pressed", String(!isVisible));
  });
  ["donorSearch", "donorCityFilter", "donorBloodFilter", "donorAvailabilityFilter", "donorEligibilityFilter"].forEach(id => {
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
