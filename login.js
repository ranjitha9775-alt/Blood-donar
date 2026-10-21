(() => {
  "use strict";

  const loginPanel = document.getElementById("loginPanel");
  const availabilityPanel = document.getElementById("availabilityPanel");
  const loginMessage = document.getElementById("loginMessage");
  const searchMessage = document.getElementById("searchMessage");
  const searchResults = document.getElementById("searchResults");
  const registrationComplete = new URLSearchParams(window.location.search).get("registered") === "1";
  const requestedReturn = new URLSearchParams(window.location.search).get("next");
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
    loginMessage.textContent = message;
  }

  function showAvailability(user) {
    loginPanel.hidden = true;
    availabilityPanel.hidden = false;
    document.getElementById("profileName").textContent = user.full_name;
    document.getElementById("profileRole").textContent = `${user.role} account · ${user.email}`;
    searchMessage.textContent = "";
    searchResults.textContent = "Enter a city to search.";
  }

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
          email: form.elements.email.value.trim(),
          password: form.elements.password.value
        })
      });
      form.reset();
      if (returnUrl) {
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

  document.getElementById("availabilityForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const params = new URLSearchParams({
      city: form.elements.city.value.trim(),
      state: form.elements.state.value.trim()
    });
    if (form.elements.blood_group.value) params.set("blood_group", form.elements.blood_group.value);
    searchResults.textContent = "Checking current availability…";
    searchMessage.textContent = "";
    try {
      const data = await requestJson(`/api/availability?${params}`);
      if (!data.donors.length) {
        searchResults.innerHTML = '<div class="empty">No opted-in donors are currently available for this search.</div>';
        return;
      }
      const checkedAt = new Date(data.checked_at);
      searchResults.innerHTML =
        `<p class="help">${data.donors.length} available donor${data.donors.length === 1 ? "" : "s"} · Checked ${escapeHtml(checkedAt.toLocaleTimeString())}</p>` +
        data.donors.map(donor => {
          const availableUntil = new Date(donor.available_until);
          return `<article class="result-card">
            <h3>${escapeHtml(donor.name)} · ${escapeHtml(donor.blood_group)}</h3>
            <p>${escapeHtml(donor.place)}, ${escapeHtml(donor.city)}, ${escapeHtml(donor.state)}</p>
            <p>Available until ${escapeHtml(availableUntil.toLocaleString())}</p>
            <p>Phone: <a href="tel:${escapeHtml(donor.phone)}">${escapeHtml(donor.phone)}</a></p>
          </article>`;
        }).join("");
    } catch (error) {
      console.error("Availability search failed:", error);
      searchResults.textContent = "";
      searchMessage.textContent = error.message;
      if (error.message.toLowerCase().includes("log in")) showLogin(error.message);
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

  requestJson("/api/me")
    .then(data => {
      if (data.user && returnUrl) {
        window.location.assign(returnUrl.href);
      } else if (data.user) {
        showAvailability(data.user);
        if (registrationComplete) searchMessage.textContent = "Registration successful. Your account is ready, and you are signed in.";
      } else {
        showLogin();
      }
    })
    .catch(error => {
      console.error("Could not check the login session:", error);
      showLogin(error.message);
    });
})();
