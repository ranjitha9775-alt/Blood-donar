"use strict";

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.headers || {}), ...(options.body ? { "Content-Type": "application/json" } : {}) }
  });
  const result = await response.json().catch(() => {
    throw new Error("The server returned an invalid response.");
  });
  if (!response.ok) throw new Error(result.message || "The request could not be completed.");
  return result;
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

const answerLabels = {
  feeling_well: "Feeling well today",
  recent_illness: "Recent illness or fever",
  taking_medication: "Currently taking medication",
  previously_deferred: "Previously deferred",
  last_donation_date: "Last donation date"
};

function renderScreening(screening) {
  const card = document.createElement("article");
  card.className = "screening";
  card.append(
    textElement("h2", `Screening ${screening.screening_id} · ${screening.full_name} · ${screening.blood_group}`),
    textElement("p", `Submitted ${new Date(screening.submitted_at).toLocaleString()}`, "muted")
  );
  const answers = document.createElement("div");
  answers.className = "answers";
  for (const [key, label] of Object.entries(answerLabels)) {
    const raw = screening.responses?.[key];
    const answer = raw === "yes" ? "Yes"
      : raw === "no" ? "No"
        : raw === "not_sure" ? "Not sure"
          : raw || "Not provided";
    answers.append(textElement("div", `${label}: ${answer}`, "answer"));
  }
  card.append(answers);
  const notesLabel = textElement("label", "Review note (optional, 500 characters max)");
  const notes = document.createElement("textarea");
  notes.maxLength = 500;
  notesLabel.append(notes);
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [reviewStatus, buttonText, className] of [
    ["Cleared", "Mark reviewed — cleared", ""],
    ["Not Cleared", "Mark not cleared", "not-cleared"]
  ]) {
    const button = textElement("button", buttonText, className);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await requestJson(`/api/blood-bank/health-screenings/${screening.screening_id}/review`, {
          method: "POST",
          body: JSON.stringify({ review_status: reviewStatus, review_notes: notes.value.trim() })
        });
        await loadScreenings();
      } catch (error) {
        document.getElementById("reviewMessage").textContent = error.message;
        button.disabled = false;
      }
    });
    actions.append(button);
  }
  card.append(notesLabel, actions);
  return card;
}

async function loadScreenings() {
  const container = document.getElementById("screenings");
  const message = document.getElementById("reviewMessage");
  try {
    const { screenings } = await requestJson("/api/blood-bank/health-screenings");
    container.replaceChildren(...screenings.map(renderScreening));
    message.textContent = screenings.length
      ? `${screenings.length} pending screening(s).`
      : "No pending donor screenings.";
  } catch (error) {
    console.error("Could not load blood-bank screenings:", error);
    message.textContent = error.message;
  }
}

async function initialize() {
  try {
    const { user } = await requestJson("/api/me");
    if (!user) {
      window.location.replace("/login");
      return;
    }
    if (user.role !== "blood_bank") {
      window.location.replace(user.role === "donor" ? "/donar-dashboard.html" : "/patient-dashboard.html");
      return;
    }
    document.getElementById("logout-button").hidden = false;
    await loadScreenings();
  } catch (error) {
    document.getElementById("reviewMessage").textContent = error.message;
  }
}

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    if (response.ok) window.location.replace("/login");
    else document.getElementById("reviewMessage").textContent = "Logout failed. Please try again.";
  } catch (error) {
    document.getElementById("reviewMessage").textContent = error.message;
  }
});

initialize();
