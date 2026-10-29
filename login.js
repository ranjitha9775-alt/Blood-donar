(() => {
  "use strict";

  const loginPanel = document.getElementById("loginPanel");
  const availabilityPanel = document.getElementById("availabilityPanel");
  const loginMessage = document.getElementById("loginMessage");
  const switchAccountButton = document.getElementById("switchAccountButton");
  const searchMessage = document.getElementById("searchMessage");
  const searchResults = document.getElementById("searchResults");
  let emergencyResponseConsent = false;
  let isSearchingDonors = false;
  const registrationComplete = new URLSearchParams(window.location.search).get("registered") === "1";
  const loginParams = new URLSearchParams(window.location.search);
  const requestedReturn = loginParams.get("next");
  const requiredRole = loginParams.get("required_role");
  let returnUrl = null;
  if (requestedReturn) {
    try {
      const candidate = new URL(requestedReturn, window.location.origin);
      if (candidate.origin === window.location.origin && candidate.pathname.startsWith("/") && !candidate.pathname.startsWith("//")) {
        returnUrl = candidate;
      }
    } catch (error) {
      console.error("Invalid post-login return path:", error);
    }
  }
  if (returnUrl) {
    const registerLink = document.querySelector(".login-footer a");
    registerLink.href = `/?register=1&next=${encodeURIComponent(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`)}`;
  }
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("The server returned an invalid response. Please try again.");
    }
    if (!response.ok) throw new Error(data.message || "The request failed. Please try again.");
    return data;
  }

  function showLogin(message = "") {
    loginPanel.hidden = false;
    availabilityPanel.hidden = true;
    document.getElementById("donorAvailabilityForm").hidden = true;
    loginMessage.textContent = message;
    switchAccountButton.hidden = true;
  }

  function showRoleMismatch(user) {
    const roleLabel = requiredRole.replaceAll("_", " ");
    const isPatientMismatch = requiredRole === "patient";
    const patientDestination = returnUrl?.searchParams.get("open") === "request"
      ? "Emergency Blood Request"
      : "Live Donor Search";
    showLogin(isPatientMismatch
      ? `${patientDestination} requires a patient account. You are signed in as ${user.role.replaceAll("_", " ")}. Your account will not be changed; log out and sign in with an existing patient account.`
      : `This page requires a ${roleLabel} account. You are signed in as ${user.role.replaceAll("_", " ")}. Log out and sign in with the correct account.`);
    switchAccountButton.hidden = false;
    switchAccountButton.textContent = isPatientMismatch
      ? "Switch to Patient Account"
      : "Log out to switch accounts";
  }

  function showAvailability(user) {
    if (user.role === "blood_bank") {
      window.location.assign("/blood-bank-portal.html");
      return;
    }
    loginPanel.hidden = true;
    availabilityPanel.hidden = false;
    document.getElementById("profileName").textContent = user.full_name;
    document.getElementById("profileRole").textContent = `${user.role} account · ${user.username || user.email}`;
    const donorAvailabilityForm = document.getElementById("donorAvailabilityForm");
    const form = document.getElementById("availabilityForm");
    const isDonor = user.role === "donor";
    document.getElementById("availabilityTitle").textContent =
      isDonor ? "Manage donor availability" : "Available donors near your location";
    document.getElementById("availabilityHelp").textContent = isDonor
      ? "Manage your current availability here, or open the Donor Portal to save availability dates and manage your full donor profile."
      : "We automatically check currently available registered donors matching your city, state, and blood-group filter. Results show registered names and city/area only for donors who opted in. Phone numbers are shared only after a donor accepts a specific request and separately consents.";
    form.hidden = isDonor;
    document.getElementById("searchMessage").hidden = isDonor;
    document.getElementById("searchResults").hidden = isDonor;
    form.elements.city.value = user.city || "";
    form.elements.state.value = user.state || "";
    donorAvailabilityForm.hidden = !isDonor;
    if (isDonor) loadDonorAvailability();
    if (!isDonor && user.city && user.state && form.elements.blood_group.value) {
      searchAvailableDonors();
    } else if (!isDonor) {
      searchMessage.textContent = "Choose a blood group, city/place, and state to search for currently available donors.";
      searchResults.textContent = "Select your search details to begin.";
    }
  }

  async function loadDonorAvailability() {
    const message = document.getElementById("donorAvailabilityMessage");
    try {
      const data = await requestJson("/api/availability/status");
      document.getElementById("donorAvailabilityConsent").checked =
        data.is_available && data.public_contact_consent;
      const startInput = document.getElementById("quickAvailabilityStart");
      const endInput = document.getElementById("quickAvailabilityEnd");
      const asLocalInput = value => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return "";
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString().slice(0, 16);
      };
      startInput.value = asLocalInput(data.availability_starts_at);
      endInput.value = asLocalInput(data.available_until);
      updateQuickAvailabilityWindow();
      emergencyResponseConsent = data.emergency_response_consent;
      message.textContent = data.is_available
        ? `Your confirmation is current until ${new Date(data.available_until).toLocaleString()}.`
        : `Your status is ${data.status}. Confirm again to refresh availability.`;
    } catch (error) {
      console.error("Could not load donor availability status:", error);
      message.textContent = error.message;
    }
  }

  function updateQuickAvailabilityWindow() {
    const enabled = document.getElementById("donorAvailabilityConsent").checked;
    document.getElementById("quickAvailabilityWindow").hidden = !enabled;
    document.getElementById("quickAvailabilityStart").required = enabled;
    document.getElementById("quickAvailabilityEnd").required = enabled;
    const now = new Date();
    const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
    document.getElementById("quickAvailabilityStart").min = localNow;
    document.getElementById("quickAvailabilityEnd").min = localNow;
  }

  document.getElementById("donorAvailabilityConsent")
    .addEventListener("change", updateQuickAvailabilityWindow);

  document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    loginMessage.textContent = "Signing in…";
    try {
      const data = await requestJson("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.elements.username.value.trim(),
          password: form.elements.password.value
        })
      });
      form.reset();
      if (returnUrl) {
        if (requiredRole && data.user.role !== requiredRole) {
          showRoleMismatch(data.user);
          return;
        }
        window.location.assign(returnUrl.href);
        return;
      }
      showAvailability(data.user);
    } catch (error) {
      console.error("Login failed:", error);
      showLogin(error.message);
    } finally {
      submitButton.disabled = false;
    }
  });

  async function searchAvailableDonors() {
    if (isSearchingDonors) return;
    const form = document.getElementById("availabilityForm");
    if (!form.reportValidity()) return;

    isSearchingDonors = true;
    const params = new URLSearchParams({
      city: form.elements.city.value.trim(),
      state: form.elements.state.value.trim()
    });
    if (form.elements.blood_group.value) params.set("blood_group", form.elements.blood_group.value);
    searchResults.textContent = "Checking current availability near your location…";
    searchMessage.textContent = "";
    try {
      const data = await requestJson(`/api/availability?${params}`);
      const checkedAt = new Date(data.checked_at);
      const checkedLabel = Number.isNaN(checkedAt.getTime())
        ? "time unavailable"
        : checkedAt.toLocaleTimeString();
      if (!data.donors.length) {
        searchResults.innerHTML =
          `<p class="help">Checked ${escapeHtml(checkedLabel)} · Updates every 15 seconds while this page is open.</p>` +
          '<div class="empty">No opted-in donors are currently available in this city and state. Try another nearby city or check again later.</div>';
        return;
      }
      searchResults.innerHTML =
        `<p class="help">${data.donors.length} available donor${data.donors.length === 1 ? "" : "s"} · Checked ${escapeHtml(checkedLabel)} · Updates every 15 seconds while this page is open.</p>` +
        data.donors.map(donor => {
          const availableUntil = new Date(donor.available_until);
          return `<article class="result-card">
            <h3>${escapeHtml(donor.name || "Donor (name not shared)")} · ${escapeHtml(donor.blood_group)}</h3>
            <p>Registered city/state: ${escapeHtml(donor.city)}, ${escapeHtml(donor.state)}</p>
            ${donor.place ? `<p>Registered area: ${escapeHtml(donor.place)}</p>` : ""}
            <p>Available until ${escapeHtml(availableUntil.toLocaleString())}</p>
            <p>Last confirmed ${escapeHtml(new Date(donor.last_confirmed_at).toLocaleString())}. Phone numbers are shared only after this donor accepts a specific request and consents to contact sharing.</p>
          </article>`;
        }).join("");
    } catch (error) {
      console.error("Availability search failed:", error);
      searchResults.textContent = "";
      searchMessage.textContent = error.message;
      if (error.message.toLowerCase().includes("log in")) showLogin(error.message);
    } finally {
      isSearchingDonors = false;
    }
  }

  document.getElementById("availabilityForm").addEventListener("submit", async event => {
    event.preventDefault();
    await searchAvailableDonors();
  });

  document.getElementById("donorAvailabilityForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const message = document.getElementById("donorAvailabilityMessage");
    button.disabled = true;
    message.textContent = "Updating your availability…";
    updateQuickAvailabilityWindow();
    if (!form.reportValidity()) {
      button.disabled = false;
      return;
    }
    try {
      const isAvailable = document.getElementById("donorAvailabilityConsent").checked;
      const startDate = new Date(document.getElementById("quickAvailabilityStart").value);
      const endDate = new Date(document.getElementById("quickAvailabilityEnd").value);
      const startsAt = isAvailable && Number.isFinite(startDate.getTime())
        ? startDate.toISOString()
        : null;
      const endsAt = isAvailable && Number.isFinite(endDate.getTime())
        ? endDate.toISOString()
        : null;
      if (isAvailable && (!startsAt || !endsAt || Date.parse(startsAt) <= Date.now() ||
          Date.parse(endsAt) <= Date.parse(startsAt))) {
        message.textContent = "Enter a future start time and a later end time.";
        button.disabled = false;
        return;
      }
      const data = await requestJson("/api/availability/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: document.getElementById("donorAvailabilityConsent").checked
            ? "available"
            : "not_available",
          ...(isAvailable ? { starts_at: startsAt, ends_at: endsAt } : {}),
          public_contact_consent: document.getElementById("donorAvailabilityConsent").checked,
          emergency_response_consent: emergencyResponseConsent
        })
      });
      message.textContent = data.is_available
        ? `Your confirmation is saved until ${new Date(data.available_until).toLocaleString()}.`
        : "Your status has been saved as Not Available.";
      await searchAvailableDonors();
    } catch (error) {
      console.error("Donor availability could not be updated:", error);
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
      await requestJson("/api/logout", { method: "POST" });
      showLogin("You have logged out.");
    } catch (error) {
      console.error("Logout failed:", error);
      searchMessage.textContent = error.message;
    }
  });

  switchAccountButton.addEventListener("click", async () => {
    switchAccountButton.disabled = true;
    try {
      await requestJson("/api/logout", { method: "POST" });
      const next = returnUrl
        ? `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`
        : "";
      const destination = new URL("/login", window.location.origin);
      if (next) destination.searchParams.set("next", next);
      if (requiredRole) destination.searchParams.set("required_role", requiredRole);
      window.location.replace(destination.href);
    } catch (error) {
      console.error("Could not switch accounts:", error);
      loginMessage.textContent = error.message;
      switchAccountButton.disabled = false;
    }
  });

  window.setInterval(() => {
    if (!availabilityPanel.hidden && !document.hidden) searchAvailableDonors();
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !availabilityPanel.hidden) searchAvailableDonors();
  });
  window.addEventListener("storage", event => {
    if (event.key === "lifedrop-availability-updated" &&
        !availabilityPanel.hidden &&
        !document.hidden) {
      searchAvailableDonors();
    }
  });

  requestJson("/api/me")
    .then(data => {
      if (data.user && returnUrl) {
        if (requiredRole && data.user.role !== requiredRole) {
          showRoleMismatch(data.user);
        } else {
          window.location.assign(returnUrl.href);
        }
      } else if (data.user) {
        showAvailability(data.user);
        if (registrationComplete) searchMessage.textContent = "Registration successful. You are now logged in.";
      } else {
        showLogin(registrationComplete ? "Registration successful. Please log in to continue." : "");
      }
    })
    .catch(error => {
      console.error("Could not check the login session:", error);
      showLogin(error.message);
    });
})();
