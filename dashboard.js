// ─── TabGroup Master — Dashboard ───

const COLOR_HEX = {
  grey: "#5f6368", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663",
  green: "#81c995", pink: "#f48fb1", purple: "#d7aefb", cyan: "#78d9ec", orange: "#fcad70",
};

let state = {
  savedGroups: [],
  categories: [],
  activeView: "overview",
};

let dragSrcGroupUid = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  bindListeners();
  render();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.categories || changes.conflicts || changes.importMode) {
    await loadData();
    render();
  }
});

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message || message.type !== "STORE_UPDATED") return;
  await loadData();
  render();
});

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response);
    });
  });
}

async function loadData() {
  const store = await sendMsg({ action: "getStore" });
  if (!store) return;
  state.savedGroups = store.savedGroups || [];
  state.categories = store.categories || [];
  const liveUids = new Set(state.savedGroups.map((g) => g.uid));
  state.categories.forEach((cat) => {
    cat.groupUids = (cat.groupUids || []).filter((u) => liveUids.has(u));
  });
}

async function persistCategories() {
  await sendMsg({ action: "saveCategories", categories: state.categories });
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".dashboard-view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${view}`);
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderWelcomeBanner();
  renderAllGroups();
  renderCategoriesGrid();
}

const WELCOME_DISMISS_KEY = "welcomeBannerDismissed";

function renderWelcomeBanner() {
  const banner = document.getElementById("welcome-banner");
  if (!banner) return;
  chrome.storage.local.get([WELCOME_DISMISS_KEY], (data) => {
    banner.classList.toggle("hidden", !!data[WELCOME_DISMISS_KEY]);
  });
}

function dismissWelcomeBanner() {
  const banner = document.getElementById("welcome-banner");
  if (banner) banner.classList.add("hidden");
  chrome.storage.local.set({ [WELCOME_DISMISS_KEY]: true });
}

function getCategorizedUids() {
  return new Set(state.categories.flatMap((c) => c.groupUids || []));
}

function renderAllGroups() {
  const list = document.getElementById("all-groups-list");
  const empty = document.getElementById("groups-empty");
  const countEl = document.getElementById("groups-count");
  const categorized = getCategorizedUids();

  const groups = [...state.savedGroups].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  countEl.textContent = groups.length;
  list.innerHTML = "";

  if (groups.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  groups.forEach((group, index) => {
    const inCat = categorized.has(group.uid);
    const card = document.createElement("div");
    card.className = "dash-group-card" + (inCat ? " in-category" : "");
    card.draggable = true;
    card.dataset.groupUid = group.uid;
    card.style.animationDelay = `${index * 35}ms`;

    const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
    const title = escHtml(group.title || "Unnamed Group");
    const tabs = (group.tabs || []).length;
    const status = group.active ? "active" : "saved";
    const statusLabel = group.active ? "Active" : "Saved";

    card.innerHTML = `
      <span class="group-dot" style="background:${dot}"></span>
      <div class="group-meta">
        <div class="group-name">${title}</div>
        <div class="group-sub">${tabs} tab${tabs !== 1 ? "s" : ""}</div>
      </div>
      <span class="status-pill ${status}">${statusLabel}</span>`;

    card.addEventListener("dragstart", (e) => {
      dragSrcGroupUid = group.uid;
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragSrcGroupUid = null;
      document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over"));
    });

    list.appendChild(card);
  });
}

function renderCategoriesGrid() {
  const grid = document.getElementById("categories-grid");
  const empty = document.getElementById("categories-empty");
  const countEl = document.getElementById("categories-count");

  countEl.textContent = state.categories.length;
  grid.innerHTML = "";

  if (state.categories.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  state.categories.forEach((cat, index) => {
    const card = document.createElement("div");
    card.className = "category-card-dash";
    card.dataset.catId = cat.id;
    card.style.animationDelay = `${index * 60}ms`;

    const catGroups = (cat.groupUids || [])
      .map((uid) => state.savedGroups.find((g) => g.uid === uid))
      .filter(Boolean);

    const groupsHtml = catGroups.length
      ? catGroups.map(buildMiniGroupHTML).join("")
      : `<div class="cat-drop-hint">Drop groups here</div>`;

    card.innerHTML = `
      <div class="cat-card-header">
        <span class="cat-card-title" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
        <span class="cat-card-count">${catGroups.length}</span>
        <div class="cat-card-actions">
          <button class="btn-rename-cat" title="Rename" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-delete-cat" title="Delete" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
      <div class="cat-card-body">${groupsHtml}</div>`;

    const body = card.querySelector(".cat-card-body");
    bindCategoryDropZone(card, body, cat.id);

    card.querySelector(".btn-rename-cat").addEventListener("click", () => startRenameCategory(cat, card));
    card.querySelector(".btn-delete-cat").addEventListener("click", () => deleteCategory(cat.id));

    grid.appendChild(card);
  });
}

function buildMiniGroupHTML(group) {
  const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
  const title = escHtml(group.title || "Unnamed Group");
  const tabs = (group.tabs || []).length;
  return `
    <div class="dash-group-card" draggable="true" data-group-uid="${group.uid}">
      <span class="group-dot" style="background:${dot}"></span>
      <div class="group-meta">
        <div class="group-name">${title}</div>
        <div class="group-sub">${tabs} tab${tabs !== 1 ? "s" : ""}</div>
      </div>
    </div>`;
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────

function bindCategoryDropZone(cardEl, bodyEl, categoryId) {
  const onDragOver = (e) => {
    if (dragSrcGroupUid === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cardEl.classList.add("drop-over");
    bodyEl.classList.add("drop-over");
  };

  const onDragLeave = (e) => {
    if (!cardEl.contains(e.relatedTarget)) {
      cardEl.classList.remove("drop-over");
      bodyEl.classList.remove("drop-over");
    }
  };

  const onDrop = async (e) => {
    e.preventDefault();
    cardEl.classList.remove("drop-over");
    bodyEl.classList.remove("drop-over");
    if (dragSrcGroupUid === null) return;

    const cat = state.categories.find((c) => c.id === categoryId);
    if (!cat) return;

    state.categories.forEach((c) => {
      c.groupUids = (c.groupUids || []).filter((u) => u !== dragSrcGroupUid);
    });

    cat.groupUids = cat.groupUids || [];
    if (!cat.groupUids.includes(dragSrcGroupUid)) {
      cat.groupUids.push(dragSrcGroupUid);
    }

    await persistCategories();
    showToast("Group added to category", "success");
    dragSrcGroupUid = null;
    render();
  };

  cardEl.addEventListener("dragover", onDragOver);
  bodyEl.addEventListener("dragover", onDragOver);
  cardEl.addEventListener("dragleave", onDragLeave);
  bodyEl.addEventListener("drop", onDrop);
  cardEl.addEventListener("drop", onDrop);

  bodyEl.querySelectorAll(".dash-group-card").forEach((miniCard) => {
    const uid = miniCard.dataset.groupUid;
    miniCard.addEventListener("dragstart", (e) => {
      dragSrcGroupUid = uid;
      e.dataTransfer.effectAllowed = "move";
      miniCard.classList.add("dragging");
    });
    miniCard.addEventListener("dragend", () => {
      miniCard.classList.remove("dragging");
      dragSrcGroupUid = null;
      document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over"));
    });
  });
}

// ─── Category CRUD ────────────────────────────────────────────────────────────

function openCategoryModal() {
  document.getElementById("dash-category-name").value = "";
  document.getElementById("dash-modal-overlay").classList.remove("hidden");
  document.getElementById("dash-category-name").focus();
}

function closeCategoryModal() {
  document.getElementById("dash-modal-overlay").classList.add("hidden");
}

async function confirmCreateCategory() {
  const name = document.getElementById("dash-category-name").value.trim();
  if (!name) return;
  state.categories.push({ id: Date.now(), name, groupUids: [], collapsed: false });
  await persistCategories();
  closeCategoryModal();
  showToast("Category created", "success");
  render();
}

function startRenameCategory(cat, cardEl) {
  const titleEl = cardEl.querySelector(".cat-card-title");
  const current = cat.name;
  const input = document.createElement("input");
  input.className = "inline-rename-dash";
  input.value = current;
  input.style.cssText = "flex:1;min-width:0;padding:4px 8px;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:6px;color:var(--text-primary);font-size:14px;font-weight:700;outline:none;";
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      cat.name = newName;
      await persistCategories();
      showToast("Category renamed", "success");
    }
    render();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") render();
  });
  input.addEventListener("blur", commit);
}

async function deleteCategory(catId) {
  state.categories = state.categories.filter((c) => c.id !== catId);
  await persistCategories();
  showToast("Category deleted", "success");
  render();
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function bindListeners() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("btn-new-category").addEventListener("click", openCategoryModal);
  document.getElementById("dash-modal-cancel").addEventListener("click", closeCategoryModal);
  document.getElementById("dash-modal-confirm").addEventListener("click", confirmCreateCategory);
  document.getElementById("dash-modal-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCategoryModal();
  });
  document.getElementById("dash-category-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmCreateCategory();
    if (e.key === "Escape") closeCategoryModal();
  });

  document.getElementById("welcome-banner-dismiss")?.addEventListener("click", dismissWelcomeBanner);

  document.getElementById("btn-export-json")?.addEventListener("click", exportToJson);

  document.querySelectorAll(".info-tooltip").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.copy;
      const el = document.getElementById(id);
      if (!el) return;
      try {
        await navigator.clipboard.writeText(el.textContent);
        showToast("Copied to clipboard", "info");
      } catch (_) {
        showToast("Copy failed", "error");
      }
    });
  });
}

// ─── JSON Export ──────────────────────────────────────────────────────────────

async function exportToJson() {
  await loadData();
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "TabGroup Master",
    version: "1.0.0",
    savedGroups: state.savedGroups,
    categories: state.categories,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "TabGroup_Master_Backup.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Backup exported successfully", "success");
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container || !message) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("toast-visible")));
  const dismiss = () => {
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-out");
    const remove = () => toast.remove();
    toast.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 400);
  };
  setTimeout(dismiss, 3000);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
