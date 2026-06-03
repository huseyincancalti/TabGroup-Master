const CHROME_COLORS = [
  "grey", "blue", "red", "yellow", "green",
  "pink", "purple", "cyan", "orange",
];

const COLOR_HEX = {
  grey: "#5f6368", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663",
  green: "#81c995", pink: "#f48fb1", purple: "#d7aefb", cyan: "#78d9ec", orange: "#fcad70",
};

const state = {
  savedGroups: [],
  folders: [],
  searchQuery: "",
  editingGroupUid: null,
  activeTab: "active",
  groupIndex: new Map(),
};

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  bindStaticListeners();
  render();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.folders) {
    await loadData();
    render();
  }
});

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message) return;
  if (message.type === "STORE_UPDATED") {
    await loadData();
    render();
  }
});

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

async function loadData() {
  const store = await sendMsg({ action: "getStore" });
  if (!store) return;
  state.savedGroups = store.savedGroups || [];
  state.folders = store.folders || [];
  buildIndexes();
}

function buildIndexes() {
  state.groupIndex = new Map(state.savedGroups.map((g) => [g.uid, g]));
}

function getGroupTabCount(group) {
  if (typeof group.tabCount === "number") return group.tabCount;
  return (group.tabs || []).length;
}

function normalizeText(value) {
  return String(value)
    .replace(/İ/g, "i").replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function titleMatchesSearch(title, query) {
  if (!query) return true;
  return normalizeText(title || "Unnamed Group").includes(normalizeText(query));
}

function highlightTitle(title, query) {
  const raw = title || "Unnamed Group";
  if (!query) return escHtml(raw);
  const idx = normalizeText(raw).indexOf(normalizeText(query));
  if (idx === -1) return escHtml(raw);
  return escHtml(raw.substring(0, idx)) +
    `<span class="search-highlight">${escHtml(raw.substring(idx, idx + query.length))}</span>` +
    escHtml(raw.substring(idx + query.length));
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTabsList(listEl, tabs) {
  listEl.innerHTML = "";
  if (!tabs.length) {
    listEl.innerHTML = "<li class=\"group-tab-empty\">No tabs</li>";
    return;
  }
  const frag = document.createDocumentFragment();
  tabs.forEach((tab) => {
    const li = document.createElement("li");
    li.className = "group-tab-item";
    li.textContent = tab.title || tab.url || "Untitled";
    li.title = tab.url || "";
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
}

async function toggleGroupTabsList(card, group) {
  let list = card.querySelector(".group-tabs-list");
  if (list && !list.classList.contains("hidden")) {
    list.classList.add("hidden");
    return;
  }
  if (!list) {
    list = document.createElement("ul");
    list.className = "group-tabs-list";
    card.appendChild(list);
  }
  list.classList.remove("hidden");
  if (group.tabsLoaded && group.tabs?.length) {
    renderTabsList(list, group.tabs);
    return;
  }
  list.innerHTML = "<li class=\"group-tab-loading\">Loading…</li>";
  const res = await sendMsg({ action: "loadGroupTabs", groupUid: group.uid });
  if (!res?.ok) {
    list.innerHTML = "<li class=\"group-tab-empty\">Could not load tabs</li>";
    return;
  }
  group.tabs = res.tabs || [];
  group.tabCount = group.tabs.length;
  group.tabsLoaded = true;
  renderTabsList(list, group.tabs);
}

function bindTabCountExpand(card, group) {
  const countEl = card.querySelector(".group-tab-count");
  if (!countEl) return;
  countEl.classList.add("group-tab-count-expandable");
  countEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGroupTabsList(card, group);
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".pane").forEach((pane) => pane.classList.add("hidden"));
  document.getElementById(`pane-${tabName}`)?.classList.remove("hidden");
}

function render() {
  renderActivePane();
  renderSavedPane();
}

function renderActivePane() {
  const container = document.getElementById("active-groups-list");
  if (!container) return;

  const active = state.savedGroups
    .filter((g) => g.active)
    .filter((g) => titleMatchesSearch(g.title, state.searchQuery));

  document.getElementById("empty-active").classList.toggle("hidden", active.length > 0);

  const frag = document.createDocumentFragment();
  active.forEach((group, index) => {
    const card = document.createElement("div");
    card.className = "group-card animate-in";
    card.style.animationDelay = `${index * 40}ms`;
    card.innerHTML = buildGroupCardHTML(group);
    bindActiveCardActions(card, group);
    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function buildGroupCardHTML(group) {
  const title = highlightTitle(group.title, state.searchQuery);
  const tabCount = getGroupTabCount(group);
  const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
  const inFolder = group.folderId ? `<span class="folder-tag" title="Organized in Workspace">📁</span>` : "";
  return `
    <span class="group-color-dot" style="background:${dot}"></span>
    <div class="group-info">
      <div class="group-title">${title} ${inFolder}</div>
      <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
    </div>
    <div class="group-actions">
      <button class="edit-group-btn" type="button" title="Edit group">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="toggle-group-btn" type="button" title="Collapse/Expand in Chrome">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="9" y1="3" x2="9" y2="21"/>
        </svg>
      </button>
      <button class="delete-active-btn delete-btn" type="button" title="Delete from storage">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
      </button>
    </div>`;
}

function bindActiveCardActions(card, group) {
  bindTabCountExpand(card, group);

  card.querySelector(".edit-group-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openEditModal(group);
  });

  card.querySelector(".delete-active-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${group.title || "Unnamed Group"}" permanently?`)) return;
    (e.currentTarget.closest(".group-card") || card).remove();
    state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
    buildIndexes();
    document.getElementById("empty-active")?.classList.toggle("hidden", state.savedGroups.some((g) => g.active));
    showToast("Group deleted", "success");
    sendMsg({ action: "deleteGroup", groupUid: group.uid });
  });

  card.querySelector(".toggle-group-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (group.active && group.chromeGroupId != null) {
      try {
        const cg = await chrome.tabGroups.get(group.chromeGroupId);
        await chrome.tabGroups.update(group.chromeGroupId, { collapsed: !cg.collapsed });
      } catch (_) {}
    }
  });
}

function getInboxGroups() {
  return state.savedGroups
    .filter((g) => !g.active && g.folderId == null)
    .filter((g) => titleMatchesSearch(g.title, state.searchQuery));
}

function updateSavedEmptyState() {
  document.getElementById("empty-saved")?.classList.toggle("hidden", getInboxGroups().length > 0);
}

function renderSavedPane() {
  const container = document.getElementById("saved-groups-list");
  if (!container) return;

  const inbox = getInboxGroups();
  updateSavedEmptyState();

  const frag = document.createDocumentFragment();
  inbox.forEach((group, index) => {
    const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
    const title = highlightTitle(group.title, state.searchQuery);
    const tabCount = getGroupTabCount(group);

    const card = document.createElement("div");
    card.className = "group-card saved-group-card animate-in";
    card.dataset.groupUid = group.uid;
    card.style.animationDelay = `${index * 40}ms`;
    card.innerHTML = `
      <span class="group-color-dot" style="background:${dot}"></span>
      <div class="group-info">
        <div class="group-title">${title}</div>
        <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
      </div>
      <div class="group-actions">
        <button class="restore-btn" type="button" title="Restore group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
          </svg>
        </button>
        <button class="delete-btn" type="button" title="Delete group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
        </button>
      </div>`;

    card.querySelector(".restore-btn").addEventListener("click", async () => {
      const res = await sendMsg({ action: "restoreGroup", groupUid: group.uid });
      if (res?.ok) showToast("Group restored", "success");
      else showToast(res?.error || "Could not restore group", "error");
    });

    card.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      (e.currentTarget.closest(".saved-group-card") || card).remove();
      state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
      buildIndexes();
      updateSavedEmptyState();
      showToast("Group deleted", "success");
      sendMsg({ action: "deleteGroup", groupUid: group.uid });
    });

    bindTabCountExpand(card, group);
    frag.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(frag);
}

function openEditModal(group) {
  state.editingGroupUid = group.uid;
  document.getElementById("edit-group-title").value = group.title || "";
  buildColorPicker(group.color || "grey");
  document.getElementById("edit-modal-overlay").classList.remove("hidden");
  document.getElementById("edit-group-title").focus();
}

function buildColorPicker(selectedColor) {
  const picker = document.getElementById("edit-color-picker");
  picker.innerHTML = "";
  CHROME_COLORS.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "color-swatch" + (color === selectedColor ? " selected" : "");
    swatch.style.background = COLOR_HEX[color];
    swatch.dataset.color = color;
    swatch.title = color;
    swatch.addEventListener("click", () => {
      picker.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
    });
    picker.appendChild(swatch);
  });
}

function closeEditModal() {
  state.editingGroupUid = null;
  document.getElementById("edit-modal-overlay").classList.add("hidden");
}

async function confirmEditGroup() {
  const groupUid = state.editingGroupUid;
  if (!groupUid) return;
  const title = document.getElementById("edit-group-title").value.trim();
  const selectedSwatch = document.querySelector("#edit-color-picker .color-swatch.selected");
  const color = selectedSwatch ? selectedSwatch.dataset.color : undefined;
  const ops = [];
  if (title) ops.push(sendMsg({ action: "updateGroupTitle", groupUid, title }));
  if (color) ops.push(sendMsg({ action: "updateGroupColor", groupUid, color }));
  await Promise.all(ops);
  closeEditModal();
}

let _importing = false;

// ── Import overlay helpers ──────────────────────────────────────────────────

function showImportOverlay() {
  document.getElementById("import-overlay")?.classList.remove("hidden");
}

function hideImportOverlay() {
  document.getElementById("import-overlay")?.classList.add("hidden");
}

function setImportStep(step) {
  // step: "loading" | "picker" | "importing"
  const pickerEl    = document.getElementById("step-picker");
  const importingEl = document.getElementById("step-importing");
  const loadingEl   = document.getElementById("profile-list-loading");
  const listEl      = document.getElementById("profile-list");
  const actionsEl   = document.getElementById("profile-actions");
  if (!pickerEl || !importingEl) return;

  if (step === "loading") {
    pickerEl.classList.remove("hidden");
    importingEl.classList.add("hidden");
    loadingEl?.classList.remove("hidden");
    listEl?.classList.add("hidden");
    actionsEl?.classList.add("hidden");
  } else if (step === "picker") {
    pickerEl.classList.remove("hidden");
    importingEl.classList.add("hidden");
    loadingEl?.classList.add("hidden");
    listEl?.classList.remove("hidden");
    actionsEl?.classList.remove("hidden");
  } else if (step === "importing") {
    pickerEl.classList.add("hidden");
    importingEl.classList.remove("hidden");
  }
}

function populateProfileList(profiles) {
  const list = document.getElementById("profile-list");
  if (!list) return;
  list.innerHTML = "";
  profiles.forEach((p) => {
    const label = document.createElement("label");
    label.className = "profile-item";
    const initial = (p.displayName || p.profileName || "?")[0].toUpperCase();
    label.innerHTML = `
      <input type="checkbox" class="profile-check" value="${escHtml(p.dir)}" checked />
      <div class="profile-avatar">${escHtml(initial)}</div>
      <div class="profile-info">
        <span class="profile-display-name">${escHtml(p.displayName || p.profileName)}</span>
        ${p.email ? `<span class="profile-email">${escHtml(p.email)}</span>` : ""}
      </div>`;
    list.appendChild(label);
  });
}

async function doImport(profileDirs) {
  setImportStep("importing");
  try {
    const res = await sendMsg({ action: "importFromChrome", profileDirs: profileDirs || null });
    if (res?.ok) {
      await loadData();
      render();
      const msg = res.added > 0
        ? `Imported ${res.added} new group${res.added !== 1 ? "s" : ""} (${res.total} found)`
        : `No new groups — ${res.total} already up to date`;
      showToast(msg, res.added > 0 ? "success" : "info");
    } else {
      showToast(res?.error || "Import failed", "error");
    }
  } finally {
    _importing = false;
    hideImportOverlay();
  }
}

async function runImport() {
  if (_importing) return;
  _importing = true;

  setImportStep("loading");
  showImportOverlay();

  const profilesRes = await sendMsg({ action: "listChromeProfiles" });

  if (!profilesRes?.ok) {
    hideImportOverlay();
    _importing = false;
    showToast(profilesRes?.error || "Native host not found — run NativeHost/install.bat first", "error");
    return;
  }

  const profiles = profilesRes.profiles || [];

  // 0 or 1 profile → skip the picker, import immediately
  if (profiles.length <= 1) {
    await doImport(null);
    return;
  }

  populateProfileList(profiles);
  setImportStep("picker");
}

async function refreshWorkspace() {
  await loadData();
  render();
  showToast("Workspace refreshed", "success");
}

function openResetWorkspaceModal() {
  document.getElementById("sp-reset-overlay")?.classList.remove("hidden");
}

function closeResetWorkspaceModal() {
  document.getElementById("sp-reset-overlay")?.classList.add("hidden");
}

async function confirmResetWorkspace() {
  closeResetWorkspaceModal();
  await chrome.storage.local.remove(["savedGroups", "folders"]);
  state.savedGroups = [];
  state.folders = [];
  buildIndexes();
  render();
  showToast("Workspace reset", "success");
}

function bindStaticListeners() {
  document.getElementById("btn-open-dashboard")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  document.getElementById("btn-import-chrome")?.addEventListener("click", runImport);

  document.getElementById("btn-picker-cancel")?.addEventListener("click", () => {
    _importing = false;
    hideImportOverlay();
  });

  document.getElementById("btn-picker-confirm")?.addEventListener("click", async () => {
    const checked = [...document.querySelectorAll(".profile-check:checked")];
    const dirs = checked.map((cb) => cb.value).filter(Boolean);
    await doImport(dirs.length > 0 ? dirs : null);
  });

  document.getElementById("btn-refresh-workspace")?.addEventListener("click", refreshWorkspace);
  document.getElementById("btn-reset-workspace")?.addEventListener("click", openResetWorkspaceModal);
  document.getElementById("sp-reset-cancel")?.addEventListener("click", closeResetWorkspaceModal);
  document.getElementById("sp-reset-confirm")?.addEventListener("click", confirmResetWorkspace);
  document.getElementById("sp-reset-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeResetWorkspaceModal();
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    render();
  });

  document.getElementById("edit-modal-cancel").addEventListener("click", closeEditModal);
  document.getElementById("edit-modal-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEditModal();
  });
  document.getElementById("edit-modal-confirm").addEventListener("click", confirmEditGroup);
  document.getElementById("edit-group-title").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmEditGroup();
    if (e.key === "Escape") closeEditModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("sp-reset-overlay")?.classList.contains("hidden")) {
      closeResetWorkspaceModal();
    }
    // Cancel import only on the picker step (not while actually importing)
    const overlay = document.getElementById("import-overlay");
    const pickerStep = document.getElementById("step-picker");
    if (overlay && !overlay.classList.contains("hidden") &&
        pickerStep && !pickerStep.classList.contains("hidden")) {
      _importing = false;
      hideImportOverlay();
    }
  });
}

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
    setTimeout(() => toast.remove(), 400);
  };
  setTimeout(dismiss, 3000);
}
