(() => {
      "use strict";
  const registeredCampIds = new Set();
  const requestStatuses = ["Pending Verification", "Under Review", "Fulfilled", "Cancelled"];
  let bloodRequests = [];
  let requestAuthorized = false;
      const sampleCamps = [
        { id: "camp-demo-01", name: "Community Care Donation Day", organiser: "LifeDrop Demo Team", venue: "Community Hall, Bengaluru", city: "Bengaluru", day: "18", month: "NOV", date: "2026-11-18", time: "10:00 AM – 3:00 PM" },
        { id: "camp-demo-02", name: "Give Blood, Share Hope", organiser: "Sample Youth Group", venue: "Demo Civic Centre, Mysuru", city: "Mysuru", day: "24", month: "NOV", date: "2026-11-24", time: "9:00 AM – 1:00 PM" },
        { id: "camp-demo-03", name: "Neighbourhood Donor Meet", organiser: "Community Demo Network", venue: "Illustrative Venue, Chennai", city: "Chennai", day: "02", month: "DEC", date: "2026-12-02", time: "10:00 AM – 2:00 PM" }
      ];
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.add("show");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3600);
      }
      function formatDate(value) {
        if (!value) return "Date not provided";
        const date = new Date(`${value}T00:00:00`);
        return Number.isNaN(date.getTime()) ? "Date not provided" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      }
      async function requestJson(url, options) {
        const response = await fetch(url, options);
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error("The service returned an invalid response.");
        }
        if (!response.ok) {
          const error = new Error(result.message || "The request could not be completed.");
          error.status = response.status;
          throw error;
        }
        return result;
      }
      let stockFilters = null;
      function setStockOptions(select, options, firstLabel) {
        select.replaceChildren(new Option(firstLabel, ""));
        options.forEach(option => select.add(new Option(option.name, option.code)));
      }
      function updateHospitalDistricts() {
        const state = stockFilters.states.find(item => item.code === document.getElementById("hospitalState").value);
        setStockOptions(document.getElementById("hospitalDistrict"), state?.districts || [], "All districts");
      }
      async function loadHospitals() {
        const form = document.getElementById("hospitalSearchForm");
        const hospitalSelect = form.elements.hospital_code;
        const button = form.querySelector('button[type="submit"]');
        const results = document.getElementById("hospitalStockResults");
        const message = document.getElementById("hospitalMessage");
        hospitalSelect.disabled = true;
        button.disabled = true;
        results.replaceChildren();
        message.textContent = "Loading hospitals and blood centres for this location…";
        const params = new URLSearchParams({
          state_code: form.elements.state_code.value,
          component_id: form.elements.component_id.value
        });
        if (form.elements.district_id.value) params.set("district_id", form.elements.district_id.value);
        try {
          const data = await requestJson(`/api/blood-stocks/hospitals?${params}`);
          hospitalSelect.replaceChildren(new Option(
            data.hospitals.length ? "Choose a hospital or blood centre" : "No hospitals listed for this location",
            ""
          ));
          data.hospitals.forEach(hospital => hospitalSelect.add(new Option(hospital.name, hospital.code)));
          hospitalSelect.disabled = data.hospitals.length === 0;
          button.disabled = data.hospitals.length === 0;
          message.textContent = data.hospitals.length
            ? `${data.hospitals.length} hospital or blood-centre choices available. Select one to view reported units.`
            : "No hospital or blood-centre choices were returned for this location.";
        } catch (error) {
          console.error("Hospital choices could not be loaded:", error);
          hospitalSelect.replaceChildren(new Option("Hospital choices unavailable", ""));
          message.textContent = error.message;
        }
      }
      function renderHospitalStock(data) {
        const results = document.getElementById("hospitalStockResults");
        const message = document.getElementById("hospitalMessage");
        const checkedAt = new Date(data.checked_at);
        const checkedLabel = Number.isNaN(checkedAt.getTime()) ? "time unavailable" : checkedAt.toLocaleString();
        const centre = data.centres[0];
        if (!centre || !centre.stocks.length) {
          message.textContent = `No blood-group units were reported for this selection · Checked ${checkedLabel}.`;
          results.innerHTML = '<div class="empty-state">No blood-stock quantities were returned. This does not confirm the centre has no stock; contact it to verify.</div>';
          return;
        }
        message.textContent = `${data.component} · ${data.district ? `${data.district}, ` : ""}${data.state} · Checked ${checkedLabel}.`;
        results.innerHTML = `<div class="stock-groups">${centre.stocks.map(stock => `
          <div class="stock-group"><strong>${escapeHtml(stock.blood_group)}</strong><span>${stock.units === null ? "Not reported" : `${escapeHtml(stock.units)} units`}</span></div>
        `).join("")}</div>`;
      }
      async function searchHospitalStock(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const message = document.getElementById("hospitalMessage");
        const results = document.getElementById("hospitalStockResults");
        if (!form.reportValidity()) return;
        button.disabled = true;
        message.textContent = "Checking reported blood stock…";
        results.replaceChildren();
        const params = new URLSearchParams({
          state_code: form.elements.state_code.value,
          component_id: form.elements.component_id.value,
          hospital_code: form.elements.hospital_code.value
        });
        if (form.elements.district_id.value) params.set("district_id", form.elements.district_id.value);
        try {
          renderHospitalStock(await requestJson(`/api/blood-stocks/by-hospital?${params}`));
        } catch (error) {
          console.error("Hospital blood-stock lookup failed:", error);
          message.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      }
      async function initializeHospitalStockSearch() {
        const form = document.getElementById("hospitalSearchForm");
        const stateSelect = form.elements.state_code;
        const districtSelect = form.elements.district_id;
        const componentSelect = form.elements.component_id;
        try {
          stockFilters = await requestJson("/api/blood-stocks/filters");
          setStockOptions(stateSelect, stockFilters.states, "Select a state");
          setStockOptions(componentSelect, stockFilters.components, "Select a blood component");
          stateSelect.value = stockFilters.states.find(item => item.name.toLowerCase() === "karnataka")?.code || "";
          componentSelect.value = stockFilters.components.find(item => item.name.toLowerCase() === "packed red blood cells")?.code ||
            stockFilters.components[0]?.code || "";
          updateHospitalDistricts();
          const defaultDistrict = stockFilters.states.find(item => item.code === stateSelect.value)
            ?.districts.find(item => /^(bengaluru|bangalore) urban$/i.test(item.name));
          if (defaultDistrict) districtSelect.value = defaultDistrict.code;
          stateSelect.disabled = false;
          districtSelect.disabled = false;
          componentSelect.disabled = false;
          stateSelect.addEventListener("change", () => {
            updateHospitalDistricts();
            loadHospitals();
          });
          districtSelect.addEventListener("change", loadHospitals);
          componentSelect.addEventListener("change", loadHospitals);
          form.addEventListener("submit", searchHospitalStock);
          await loadHospitals();
        } catch (error) {
          console.error("Blood-stock filters could not be loaded:", error);
          document.getElementById("hospitalMessage").textContent = error.message;
        }
      }
      function renderRequests() {
        const list = document.getElementById("requestList");
        document.getElementById("requestCount").textContent = requestAuthorized ? String(bloodRequests.length) : "Login";
        if (!requestAuthorized) {
          list.innerHTML = '<div class="panel-title"><h3>Recent requests</h3><span class="live-tag">Login required</span></div><div class="empty-state">Log in to view the shared request board. <a href="/login?next=%2F%23urgent">Log in to LifeDrop</a></div>';
          return;
        }
        if (!bloodRequests.length) {
          list.innerHTML = '<div class="panel-title"><h3>Recent requests</h3><span class="live-tag">Shared board</span></div><div class="empty-state">No blood requests have been submitted yet.</div>';
          return;
        }
        list.innerHTML = `<div class="panel-title"><h3>Recent requests</h3><span class="live-tag">Shared board</span></div>${bloodRequests.map(request => {
          const requestLabel = `LD-${request.request_id}`;
          const statusControl = request.is_owner
            ? `<label class="request-status-control">Your status<select data-request-status="${escapeHtml(request.request_id)}" data-current-status="${escapeHtml(request.status)}" aria-label="Update status for request ${escapeHtml(requestLabel)}">${requestStatuses.map(status => `<option value="${escapeHtml(status)}"${status === request.status ? " selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></label>`
            : `<span class="status">${escapeHtml(request.status)}</span>`;
          return `<article class="request-row">
            <div class="blood-badge">${escapeHtml(request.blood_group)}</div>
            <div class="request-info">
              <strong>${escapeHtml(request.city)} · ${escapeHtml(request.units)} ${Number(request.units) === 1 ? "unit" : "units"}</strong>
              <small>Request ${escapeHtml(requestLabel)} · ${escapeHtml(request.urgency)} · Needed ${escapeHtml(formatDate((request.needed_at || "").slice(0, 10)))} · ${escapeHtml(request.verification_status)}</small>
              ${statusControl}
            </div>
          </article>`;
        }).join("")}`;
      }
      function showRequestLogin(message) {
        document.getElementById("requestForm").hidden = true;
        document.getElementById("requestLoginNotice").hidden = false;
        document.getElementById("requestAccessMessage").textContent = message;
        document.querySelector('#requestLoginNotice a').hidden = false;
        requestAuthorized = false;
        renderRequests();
      }
      async function loadBloodRequests() {
        try {
          const data = await requestJson("/api/blood-requests");
          bloodRequests = data.requests;
          requestAuthorized = true;
          document.getElementById("requestForm").hidden = false;
          document.getElementById("requestLoginNotice").hidden = true;
          document.getElementById("requestBoardMessage").textContent = "";
          document.getElementById("requestBoardMessage").style.color = "";
          renderRequests();
        } catch (error) {
          console.error("Blood-request board could not be loaded:", error);
          bloodRequests = [];
          if (error.status === 401) {
            showRequestLogin("Log in to submit a request and view the shared board.");
          } else {
            requestAuthorized = false;
            document.getElementById("requestForm").hidden = true;
            document.getElementById("requestLoginNotice").hidden = false;
            document.getElementById("requestAccessMessage").textContent = error.message;
            document.querySelector('#requestLoginNotice a').hidden = true;
            document.getElementById("requestBoardMessage").textContent = error.message;
            document.getElementById("requestBoardMessage").style.color = "var(--red)";
            renderRequests();
          }
        }
      }
      async function updateBloodRequestStatus(select) {
        const requestId = select.dataset.requestStatus;
        const previousStatus = select.dataset.currentStatus;
        const status = select.value;
        select.disabled = true;
        try {
          const result = await requestJson(`/api/blood-requests/${encodeURIComponent(requestId)}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status })
          });
          const request = bloodRequests.find(item => item.request_id === requestId);
          if (request) request.status = result.status;
          renderRequests();
          const boardMessage = document.getElementById("requestBoardMessage");
          boardMessage.textContent = "Request status updated. Status is self-reported and is not independently verified.";
          boardMessage.style.color = "var(--green)";
        } catch (error) {
          console.error("Blood-request status could not be updated:", error);
          select.value = previousStatus;
          const boardMessage = document.getElementById("requestBoardMessage");
          boardMessage.textContent = error.message;
          boardMessage.style.color = "var(--red)";
          select.disabled = false;
          if (error.status === 401) showRequestLogin("Your login session expired. Log in again to continue.");
        }
      }
      function renderCamps() {
        document.getElementById("campList").innerHTML = sampleCamps.map(camp => {
          const joined = registeredCampIds.has(camp.id);
          return `<article class="camp-card"><div class="camp-date">${escapeHtml(camp.day)}<small>${escapeHtml(camp.month)}</small></div><h3>${escapeHtml(camp.name)}</h3><p>Organiser: ${escapeHtml(camp.organiser)}</p><p>⌖ &nbsp;${escapeHtml(camp.venue)}</p><p>◷ &nbsp;${escapeHtml(camp.time)}</p><span class="demo-label">Illustrative event · Confirm details</span><br><button class="btn ${joined ? "btn-outline" : "btn-primary"} btn-small camp-interest" type="button" data-camp="${escapeHtml(camp.id)}" ${joined ? "disabled" : ""}>${joined ? "Registration saved" : "Register interest"}</button></article>`;
        }).join("");
      }
      function updateCounts() {
        document.getElementById("donorCount").textContent = "Login";
        renderRequests();
      }
      renderCamps();
      updateCounts();
      initializeHospitalStockSearch();
      loadBloodRequests();
      document.getElementById("requestList").addEventListener("change", event => {
        const statusSelect = event.target.closest("[data-request-status]");
        if (statusSelect) updateBloodRequestStatus(statusSelect);
      });
      document.getElementById("lastDonation").max = new Date().toISOString().slice(0, 10);
      document.getElementById("neededAt").min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const registrationRole = document.getElementById("registrationRole");
      const lastDonationField = document.getElementById("lastDonationField");
      const donorInterestField = document.getElementById("donorInterestField");
      const publicContactField = document.getElementById("publicContactField");
      const patientRequestFields = document.getElementById("patientRequestFields");
      function updateRegistrationFields() {
        const isDonor = registrationRole.value === "donor";
        const isPatient = registrationRole.value === "patient";
        lastDonationField.hidden = !isDonor;
        donorInterestField.hidden = !isDonor;
        publicContactField.hidden = !isDonor;
        patientRequestFields.hidden = !isPatient;
        patientRequestFields.querySelectorAll("input, select").forEach(field => {
          field.disabled = !isPatient;
          field.required = isPatient;
        });
        if (!isDonor) {
          document.getElementById("lastDonation").value = "";
          donorInterestField.querySelector("input").checked = false;
          publicContactField.querySelector("input").checked = false;
        }
        if (!isPatient) {
          document.getElementById("registrationHospital").value = "";
          document.getElementById("registrationUnits").value = "1";
          document.getElementById("registrationUrgency").value = "";
        }
      }
      registrationRole.addEventListener("change", updateRegistrationFields);
      if (new URLSearchParams(window.location.search).has("register")) {
        document.getElementById("registerDialog").showModal();
      }
      const menu = document.getElementById("navLinks");
      document.getElementById("menuToggle").addEventListener("click", event => {
        const expanded = menu.classList.toggle("open");
        event.currentTarget.setAttribute("aria-expanded", String(expanded));
      });
      menu.addEventListener("click", event => {
        if (event.target.closest("a")) {
          menu.classList.remove("open");
          document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
        }
      });
      document.addEventListener("click", event => {
        const trigger = event.target.closest("[data-open]");
        if (trigger) {
          const dialog = document.getElementById(trigger.dataset.open);
          if (dialog.id === "registerDialog" && trigger.dataset.role) {
            registrationRole.value = trigger.dataset.role;
            updateRegistrationFields();
          }
          dialog.showModal();
        }
        if (event.target.closest("[data-close]")) event.target.closest("dialog").close();
        if (event.target.matches("dialog")) event.target.close();
        const campButton = event.target.closest(".camp-interest");
        if (campButton && !campButton.disabled) {
          const camp = sampleCamps.find(item => item.id === campButton.dataset.camp);
          if (!camp) return;
          const form = document.getElementById("campRegistrationForm");
          form.elements.camp_id.value = camp.id;
          document.getElementById("campRegistrationTitle").textContent = `Register for ${camp.name}`;
          document.getElementById("campRegistrationDetails").textContent = `${camp.venue} · ${camp.date} · ${camp.time}`;
          document.getElementById("campRegistrationMessage").textContent = "";
          document.getElementById("campRegistrationDialog").showModal();
        }
      });
      document.getElementById("campRegistrationForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const submitButton = form.querySelector('button[type="submit"]');
        const message = document.getElementById("campRegistrationMessage");
        const data = new FormData(form);
        submitButton.disabled = true;
        message.textContent = "Saving your registration…";
        message.style.color = "";
        try {
          const result = await requestJson("/api/camp-registrations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              camp_id: data.get("camp_id"),
              name: String(data.get("name")).trim(),
              phone: String(data.get("phone")).trim(),
              email: String(data.get("email")).trim(),
              consent: data.has("consent")
            })
          });
          registeredCampIds.add(String(data.get("camp_id")));
          renderCamps();
          form.reset();
          document.getElementById("campRegistrationDialog").close();
          showToast(`${result.message} The camp listing is illustrative; confirm event details with the organiser.`);
        } catch (error) {
          console.error("Camp registration failed:", error);
          message.textContent = error.message;
          message.style.color = "var(--red)";
        } finally {
          submitButton.disabled = false;
        }
      });
      document.getElementById("registerForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        const role = String(data.get("role"));
        const age = Number(data.get("age"));
        const message = document.getElementById("registrationMessage");
        if (!["donor", "patient"].includes(role)) {
          message.textContent = "Select Donor or Patient before registering.";
          message.style.color = "var(--red)";
          return;
        }
        if (!Number.isInteger(age) || age < 1 || age > 120) {
          message.textContent = "Enter an age from 1 to 120.";
          message.style.color = "var(--red)";
          return;
        }
        const submitButton = form.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        message.textContent = "Registering your account…";
        message.style.color = "";
        try {
          const result = await requestJson("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              full_name: String(data.get("name")).trim(),
              email: String(data.get("email")).trim(),
              username: String(data.get("username")).trim(),
              password: data.get("password"),
              role,
              age,
              gender: data.get("gender"),
              blood_group: data.get("blood"),
              phone: String(data.get("phone")).trim(),
              city: String(data.get("city")).trim(),
              state: String(data.get("state")).trim(),
              place: String(data.get("place")).trim(),
              last_donation_date: role === "donor" ? data.get("lastDonation") || null : null,
              is_available: role === "donor" && data.has("availability"),
              public_contact_consent: role === "donor" && data.has("publicContactConsent"),
              hospital_name: role === "patient" ? String(data.get("hospital_name")).trim() : null,
              units_required: role === "patient" ? Number(data.get("units_required")) : null,
              urgency: role === "patient" ? data.get("urgency") : null,
              consent: data.has("consent")
            })
          });
          form.reset();
          updateRegistrationFields();
          message.textContent = "";
          document.getElementById("registerDialog").close();
          showToast(`${result.message} You can log in whenever you are ready.`);
          if (window.location.search) {
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
          }
        } catch (error) {
          console.error("Account registration failed:", error);
          message.textContent = error.message;
          message.style.color = "var(--red)";
        } finally {
          submitButton.disabled = false;
        }
      });
      document.getElementById("requestForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        const neededAt = String(data.get("neededAt"));
        const neededAtDate = new Date(neededAt);
        const message = document.getElementById("requestMessage");
        if (!Number.isFinite(neededAtDate.getTime()) || neededAtDate.getTime() <= Date.now()) {
          message.textContent = "Choose a future date and time, or contact the hospital immediately for urgent needs.";
          message.style.color = "var(--red)";
          return;
        }
        const submitButton = form.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        message.textContent = "Submitting request securely…";
        message.style.color = "";
        try {
          const result = await requestJson("/api/blood-requests", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              patient: String(data.get("patient")).trim(),
              blood: data.get("blood"),
              units: Number(data.get("units")),
              urgency: data.get("urgency"),
              hospital_name: String(data.get("hospitalName")).trim(),
              hospital_address: String(data.get("hospitalAddress") || "").trim(),
              city: String(data.get("city")).trim(),
              district: String(data.get("district")).trim(),
              contact_name: String(data.get("contactName")).trim(),
              contact_phone: String(data.get("contactPhone")).trim(),
              needed_at: neededAtDate.toISOString(),
              consent: data.has("requestConsent"),
              match_donors: data.has("matchDonors")
            })
          });
          const requestId = `LD-${result.request_id}`;
          form.reset();
          message.textContent = "";
          document.getElementById("requestDialog").close();
          await loadBloodRequests();
          showToast(result.matched_donor_count
            ? `Request ${requestId} saved. In-app notifications are ready for ${result.matched_donor_count} matching donor(s). No email or SMS was sent.`
            : `Request ${requestId} saved. No matching donors were available or opted in. No hospital was notified.`);
          document.getElementById("urgent").scrollIntoView({ behavior: "smooth" });
        } catch (error) {
          console.error("Blood-request submission failed:", error);
          if (error.status === 401) {
            showRequestLogin("Your login session expired. Log in again to submit a request.");
            message.textContent = error.message;
          } else {
            message.textContent = error.message;
            message.style.color = "var(--red)";
          }
        } finally {
          submitButton.disabled = false;
        }
      });
    })();
