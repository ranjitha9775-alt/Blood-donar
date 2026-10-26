(() => {
  "use strict";

  const statusLabels = {
    eligible_for_review: "Eligible for Review",
    recovery_period_in_progress: "Recovery Period in Progress",
    awaiting_eligibility_review: "Awaiting Eligibility Review",
    eligibility_confirmed: "Eligibility Confirmed",
    temporarily_ineligible: "Temporarily Ineligible",
    medical_review_required: "Medical Review Required"
  };

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => {
      throw new Error("The server returned an invalid response.");
    });
    if (!response.ok) throw new Error(data.message || "The request could not be completed.");
    return data;
  }

  function formatDate(value) {
    if (!value) return "Not recorded";
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleDateString();
  }

  function addHistoryRow(container, donation) {
    const row = document.createElement("article");
    row.className = "history-row";
    const label = donation.verification_status === "verified" ? "Verified" : donation.verification_status;
    row.textContent = `${formatDate(donation.donation_date)} · Next review date ${formatDate(donation.next_review_date)} · ${label}`;
    container.append(row);
  }

  async function loadPortal() {
    try {
      const data = await requestJson("/api/donor/eligibility-portal");
      const summary = data.summary;
      const statusElement = document.getElementById("eligibilityStatus");
      statusElement.textContent = statusLabels[summary.status] || "Medical Review Required";
      statusElement.classList.toggle("positive", summary.status === "eligibility_confirmed");
      document.getElementById("lastDonationDate").textContent = formatDate(summary.last_donation_date);
      document.getElementById("daysSinceDonation").textContent =
        summary.days_since_last_donation === null ? "—" : String(summary.days_since_last_donation);
      document.getElementById("nextReviewDate").textContent = formatDate(summary.next_review_date);
      document.getElementById("matchingStatus").textContent =
        summary.can_appear_in_live_matching ? "Can appear if availability is current" : "Not currently matchable";
      document.getElementById("recoveryLabel").textContent =
        summary.recovery_period_days === null
          ? `Recovery tracker · ${summary.eligibility_interval_months}-month configured review interval`
          : `${summary.recovery_progress_percent}% of the configured ${summary.eligibility_interval_months}-month review interval elapsed`;
      const progress = Math.max(0, Math.min(100, summary.recovery_progress_percent || 0));
      document.getElementById("recoveryProgress").style.width = `${progress}%`;
      const progressbar = document.querySelector('[role="progressbar"]');
      progressbar.setAttribute("aria-valuenow", String(progress));

      const history = document.getElementById("donationHistory");
      history.replaceChildren();
      if (!data.donations.length) {
        history.textContent = "No verified donation dates are recorded.";
      } else {
        data.donations.forEach(donation => addHistoryRow(history, donation));
      }

      const review = data.review;
      const requestLabel = review.request_status === "not_requested"
        ? "No review request submitted."
        : `Request ${review.request_status.replaceAll("_", " ")} · submitted ${review.request_date ? new Date(review.request_date).toLocaleString() : "date unavailable"}${review.request_reviewed_at ? ` · reviewed by ${review.request_reviewed_by || "admin"} on ${new Date(review.request_reviewed_at).toLocaleString()}` : ""}.`;
      document.getElementById("requestSummary").textContent = requestLabel;
      const instructions = document.getElementById("requestInstructions");
      const requestInstructionText = review.request_instructions;
      const staffInstructionText = review.staff_instructions;
      instructions.hidden = !requestInstructionText && !staffInstructionText;
      instructions.textContent = [requestInstructionText, staffInstructionText].filter(Boolean).join(" · ");
      document.getElementById("staffDecision").textContent = review.staff_decision
        ? `Staff decision: ${review.staff_decision === "eligible" ? "Eligibility confirmed" : "Temporarily ineligible"} · ${review.staff_reviewed_by || "Authorized staff"} · ${review.staff_reviewed_at ? new Date(review.staff_reviewed_at).toLocaleString() : "date unavailable"}`
        : "No staff eligibility decision recorded.";
      const requestButton = document.getElementById("requestReview");
      requestButton.hidden = !summary.can_request_review;
      requestButton.onclick = submitReviewRequest;
      if (review.request_status === "approved") {
        document.getElementById("requestSummary").textContent +=
          " Your request was accepted for professional review; this is not medical eligibility approval.";
      }
    } catch (error) {
      document.getElementById("eligibilityStatus").textContent = "Could not load eligibility status";
      document.getElementById("reviewMessage").textContent = error.message;
      if (error.message.includes("login") || error.message.includes("session")) {
        window.location.replace("/login?next=%2Fdonor-eligibility.html");
      }
    }
  }

  async function submitReviewRequest() {
    const button = document.getElementById("requestReview");
    const message = document.getElementById("reviewMessage");
    button.disabled = true;
    message.textContent = "Submitting your request…";
    try {
      const result = await requestJson("/api/donor/eligibility-review-requests", { method: "POST", body: "{}" });
      message.textContent = result.message;
      await loadPortal();
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
    }
  }

  loadPortal();
})();
