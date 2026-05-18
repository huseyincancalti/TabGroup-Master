// ─── Auto-Scan Onboarding Wizard (Side Panel + Dashboard) ───

const MacroWizard = (() => {
  let abort = false;
  let running = false;
  let options = {};

  function sendMsg(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function el(id) {
    return document.getElementById(id);
  }

  function resetWizard() {
    abort = false;
    running = false;

    const modal = el("autoscroll-wizard-modal");
    const card = modal?.querySelector(".autoscroll-wizard-card");
    const step1 = el("wizard-step-1");
    const step2 = el("wizard-step-2");
    const giant = el("wizard-giant-countdown");

    modal?.classList.remove("wizard-overlay-closing");
    card?.classList.remove("wizard-card-closing", "wizard-step2-active");

    step1?.classList.remove("hidden", "wizard-step-leaving", "wizard-step-entering");
    step2?.classList.add("hidden");
    step2?.classList.remove("wizard-step-entering", "wizard-step-leaving");

    if (giant) {
      giant.textContent = "";
      giant.classList.remove("flash");
    }
  }

  function openWizard() {
    resetWizard();
    el("autoscroll-wizard-modal")?.classList.remove("hidden");
  }

  function closeWizard() {
    abort = true;
    running = false;
    el("autoscroll-wizard-modal")?.classList.add("hidden");
    resetWizard();
  }

  async function closeWizardSmoothly() {
    const modal = el("autoscroll-wizard-modal");
    const card = modal?.querySelector(".autoscroll-wizard-card");
    if (!modal) {
      closeWizard();
      return;
    }

    modal.classList.add("wizard-overlay-closing");
    card?.classList.add("wizard-card-closing");
    await sleep(320);
    closeWizard();
  }

  function restartGif() {
    const img = el("macro-guide-gif");
    if (!img) return;
    const src = img.getAttribute("src") || "macro-guide.gif";
    img.src = "";
    img.src = src;
  }

  function flashGiantCountdown(value) {
    const giant = el("wizard-giant-countdown");
    if (!giant) return;
    giant.textContent = String(value);
    giant.classList.remove("flash");
    void giant.offsetWidth;
    giant.classList.add("flash");
  }

  function transitionToStep2() {
    const modal = el("autoscroll-wizard-modal");
    const step1 = el("wizard-step-1");
    const step2 = el("wizard-step-2");
    if (!step1 || !step2) return;

    step1.classList.add("wizard-step-leaving");
    setTimeout(() => {
      step1.classList.add("hidden");
      step1.classList.remove("wizard-step-leaving");
      step2.classList.remove("hidden");
      step2.classList.add("wizard-step-entering");
      modal?.querySelector(".autoscroll-wizard-card")?.classList.add("wizard-step2-active");
      restartGif();
      startCountdownAndScan();
    }, 260);
  }

  function onVerifyNo() {
    closeWizard();
    options.showToast?.(
      "Run install.bat inside your NativeHost folder first, then launch Auto-Scan again.",
      "info"
    );
  }

  async function enableImportMode() {
    const toggle = el("import-toggle");

    if (toggle && !toggle.checked) {
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    await sendMsg({ action: "setImportMode", value: true });

    if (toggle) {
      toggle.checked = true;
    }

    if (options.onImportModeEnabled) {
      await options.onImportModeEnabled();
    }
  }

  async function startCountdownAndScan() {
    if (running) return;
    running = true;
    abort = false;

    sendMsg({ action: "warmupNativeHost" });

    await sleep(400);

    for (let i = 3; i >= 1; i--) {
      if (abort) {
        running = false;
        return;
      }
      flashGiantCountdown(i);
      await sleep(1000);
    }

    if (abort) {
      running = false;
      return;
    }

    flashGiantCountdown(0);
    await sleep(450);

    if (abort) {
      running = false;
      return;
    }

    await enableImportMode();

    if (abort) {
      running = false;
      return;
    }

    running = false;
    await closeWizardSmoothly();

    if (abort) return;

    const res = await sendMsg({ action: "runNativeMacro" });
    await sendMsg({ action: "syncGroupsNow" });

    if (options.onComplete) {
      await options.onComplete(res);
    }

    if (res?.ok) {
      options.showToast?.("Auto-Scan completed!", "success");
    } else if (res?.error) {
      options.showToast?.(res.error, "error");
    }
  }

  function bindTriggers() {
    document.querySelectorAll("#btn-run-macro").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openWizard();
      });
    });

    el("wizard-verify-no")?.addEventListener("click", onVerifyNo);
    el("wizard-verify-yes")?.addEventListener("click", () => {
      if (!running) transitionToStep2();
    });

    el("autoscroll-wizard-modal")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget && !running) closeWizard();
    });
  }

  function init(opts = {}) {
    options = opts;
    bindTriggers();
  }

  return { init, open: openWizard, close: closeWizard };
})();
