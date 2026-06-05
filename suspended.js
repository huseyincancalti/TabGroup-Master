/* TabGroup Master — Frozen (suspended) tab page.
 * Holds a real URL without loading it, so opening a 100-tab group costs
 * almost no RAM. The page loads the moment the user views or clicks it. */

(function () {
  const params = new URLSearchParams(location.search);
  const realUrl = params.get("u") || "";
  const title   = params.get("t") || realUrl || "Frozen tab";
  const favicon = params.get("f") || "";

  // ── Populate the placeholder UI ────────────────────────────────────────────
  document.title = title;

  const titleEl = document.getElementById("title");
  const urlEl   = document.getElementById("url");
  if (titleEl) titleEl.textContent = title;
  if (urlEl) {
    try { urlEl.textContent = decodeURIComponent(realUrl); }
    catch { urlEl.textContent = realUrl; }
  }

  // Show the real favicon both in the card and on the browser tab strip,
  // so a frozen tab looks identical to a loaded one.
  if (favicon) {
    const link = document.getElementById("favicon");
    if (link) link.href = favicon;
    const wrap = document.querySelector(".fav-wrap");
    const fallback = document.getElementById("fav-fallback");
    if (wrap) {
      const img = new Image();
      img.alt = "";
      img.onload = () => { fallback?.remove(); wrap.appendChild(img); };
      img.onerror = () => {}; // keep the 🌐 fallback
      img.src = favicon;
    }
  }

  // ── Wake-up logic ──────────────────────────────────────────────────────────
  let woken = false;
  function wake() {
    if (woken || !realUrl) return;
    woken = true;
    // replace() so the frozen page never lingers in history/back button
    location.replace(realUrl);
  }

  // Load when the user actually looks at the tab (clicks it in the tab strip).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  // If this tab is already the focused one (rare on restore), load immediately.
  if (document.visibilityState === "visible" && document.hasFocus()) wake();

  // Explicit interactions.
  document.getElementById("load-btn")?.addEventListener("click", (e) => { e.stopPropagation(); wake(); });
  document.body.addEventListener("click", wake);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") wake();
  });
})();
