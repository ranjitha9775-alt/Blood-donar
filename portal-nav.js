"use strict";

(() => {
  const links = [
    ["Home", "/"],
    ["Donor Portal", "/donor-dashboard.html"],
    ["Donor Eligibility", "/donor-eligibility.html"],
    ["Blood Bank Portal", "/blood-bank-portal.html"],
    ["Patient Portal", "/login?next=%2Fpatient-dashboard.html"],
    ["Live Donor Search", "/login?next=%2Fpatient-dashboard.html"],
    ["Emergency Blood Request", "/#urgent"],
    ["Admin Portal", "/admin"],
    ["Login / Register", "/login"]
  ];

  document.querySelectorAll("[data-site-nav]").forEach(nav => {
    const toggle = nav.parentElement.querySelector("[data-site-nav-toggle]");
    nav.replaceChildren(...links.map(([label, href]) => {
      const link = document.createElement("a");
      link.textContent = label;
      link.href = href;
      if (label === "Emergency Blood Request") link.setAttribute("aria-label", label);
      return link;
    }));

    if (!toggle) return;
    const setExpanded = expanded => {
      nav.classList.toggle("open", expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
    };
    toggle.addEventListener("click", () => {
      setExpanded(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", event => {
      if (event.target.closest("a")) setExpanded(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") setExpanded(false);
    });
    document.addEventListener("click", event => {
      if (!nav.contains(event.target) && !toggle.contains(event.target)) setExpanded(false);
    });
  });
})();
