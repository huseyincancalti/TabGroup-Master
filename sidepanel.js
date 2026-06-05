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
  } else if (message.type === "RESTORED_FROM_CLOUD") {
    await loadData();
    render();
    showToast(`♻️ Restored ${message.groupCount} groups from sync backup`, "info");
  } else if (message.type === "RESTORED_FROM_BACKUP") {
    await loadData();
    render();
    showToast(
      `✅ Data restored! ${message.groupCount} groups + ${message.folderCount} folders recovered from local backup.`,
      "success"
    );
  }
});

function sendMsg(message) {
  return new Promise((resolve) => {
    let attempts = 0;
    const attempt = () => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (++attempts < 3) { setTimeout(attempt, 400); }
          else { resolve(null); }
          return;
        }
        resolve(response);
      });
    };
    attempt();
  });
}

async function loadData() {
  let store = await sendMsg({ action: "getStore" });
  if (!store) {
    // SW unresponsive — read directly from chrome.storage.local
    try {
      const raw = await chrome.storage.local.get(["savedGroups", "folders"]);
      store = { savedGroups: raw.savedGroups || [], folders: raw.folders || [] };
    } catch (_) { return; }
  }
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
      <button class="close-group-btn" type="button" title="Close window (keep group saved)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/>
          <line x1="12" y1="2" x2="12" y2="12"/>
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

  // Clicking the card body brings the group's open window to the front.
  card.querySelector(".group-info")?.addEventListener("click", (e) => {
    e.stopPropagation();
    sendMsg({ action: "focusGroupWindow", groupUid: group.uid });
  });

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

  card.querySelector(".close-group-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await sendMsg({ action: "closeGroup", groupUid: group.uid });
    if (res?.ok) showToast("Group closed — still saved in your Inbox", "success");
    else showToast("Could not close group", "error");
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
    card.draggable = true;
    card.style.animationDelay = `${index * 40}ms`;
    card.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="group-color-dot" style="background:${dot}"></span>
      <div class="group-info">
        <div class="group-title">${title}</div>
        <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
      </div>
      <div class="group-actions">
        <button class="edit-group-btn" type="button" title="Edit group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="restore-btn" type="button" title="Open in Chrome">
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

    card.querySelector(".edit-group-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(group);
    });

    card.querySelector(".restore-btn").addEventListener("click", async () => {
      const res = await sendMsg({ action: "restoreGroup", groupUid: group.uid });
      if (res?.ok) showToast("Group opened in Chrome", "success");
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

    // ── Drag-and-drop reordering ──────────────────────────────────────────────
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", group.uid);
      setTimeout(() => card.classList.add("dragging"), 0);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove("drag-over");
    });
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const dragUid = e.dataTransfer.getData("text/plain");
      if (!dragUid || dragUid === group.uid) return;

      const dragIdx = state.savedGroups.findIndex(g => g.uid === dragUid);
      const dropIdx = state.savedGroups.findIndex(g => g.uid === group.uid);
      if (dragIdx === -1 || dropIdx === -1) return;

      const [moved] = state.savedGroups.splice(dragIdx, 1);
      const newDrop  = state.savedGroups.findIndex(g => g.uid === group.uid);
      state.savedGroups.splice(newDrop, 0, moved);
      buildIndexes();
      renderSavedPane();
      sendMsg({ action: "reorderGroups", orderedUids: state.savedGroups.map(g => g.uid) });
    });

    bindTabCountExpand(card, group);
    frag.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(frag);
}

function openEditModal(group) {
  _editMode = group ? "edit" : "create";
  state.editingGroupUid = group?.uid ?? null;

  document.getElementById("edit-modal-heading").textContent = group ? "Edit Group" : "New Group";
  document.getElementById("edit-group-title").value = group?.title || "";
  buildColorPicker(group?.color || "grey");

  // Initialise tab list
  _editTabs = (group?.tabs || []).map(t => ({ ...t }));

  // If tabs haven't been loaded yet, fetch them first
  if (group && !group.tabsLoaded && group.uid) {
    renderEditTabs();
    sendMsg({ action: "loadGroupTabs", groupUid: group.uid }).then(res => {
      if (res?.ok && Array.isArray(res.tabs)) {
        _editTabs = res.tabs.map(t => ({ ...t }));
        renderEditTabs();
      }
    });
  } else {
    renderEditTabs();
  }

  document.getElementById("edit-modal-overlay").classList.remove("hidden");
  document.getElementById("edit-group-title").focus();
}

function renderEditTabs() {
  const list  = document.getElementById("edit-tab-list");
  const badge = document.getElementById("edit-tabs-badge");
  if (!list) return;
  if (badge) badge.textContent = _editTabs.length ? `(${_editTabs.length})` : "";
  list.innerHTML = "";

  if (!_editTabs.length) {
    list.innerHTML = `<div class="edit-tab-empty">No tabs yet — add one below.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  _editTabs.forEach((tab, i) => {
    const row = document.createElement("div");
    row.className = "edit-tab-row";
    const display = (tab.url || "")
      .replace(/^https?:\/\/(www\.)?/, "")
      .slice(0, 54);
    row.innerHTML = `
      <span class="edit-tab-dot"></span>
      <span class="edit-tab-url" title="${escHtml(tab.url || "")}">${escHtml(display)}</span>
      <button class="edit-tab-remove" data-i="${i}" type="button" aria-label="Remove">✕</button>`;
    row.querySelector(".edit-tab-remove").addEventListener("click", () => {
      _editTabs.splice(i, 1);
      renderEditTabs();
    });
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

function addEditTab() {
  const input = document.getElementById("new-tab-url");
  let url = (input?.value || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  _editTabs.push({ url, title: url });
  if (input) input.value = "";
  renderEditTabs();
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
  const title = document.getElementById("edit-group-title").value.trim();
  const selectedSwatch = document.querySelector("#edit-color-picker .color-swatch.selected");
  const color = selectedSwatch?.dataset.color || "grey";

  if (_editMode === "create") {
    const res = await sendMsg({
      action: "createGroup",
      title: title || "New Group",
      color,
      tabs: _editTabs,
    });
    if (res?.ok) {
      showToast("Group created ✓", "success");
      switchTab("saved"); // jump to Inbox so user sees the new group
    } else {
      showToast("Could not create group", "error");
    }
  } else {
    const groupUid = state.editingGroupUid;
    if (!groupUid) { closeEditModal(); return; }
    const ops = [
      sendMsg({ action: "updateGroupColor", groupUid, color }),
      sendMsg({ action: "updateGroupTabs",  groupUid, tabs: _editTabs }),
    ];
    if (title) ops.push(sendMsg({ action: "updateGroupTitle", groupUid, title }));
    await Promise.all(ops);
    showToast("Group updated ✓", "success");
  }
  closeEditModal();
}

let _importing = false;
let _editTabs  = [];   // mutable tab copy while edit/create modal is open
let _editMode  = "edit"; // "edit" | "create"

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

  document.getElementById("btn-new-group")?.addEventListener("click", () => openEditModal(null));

  document.getElementById("btn-close-chrome-groups")?.addEventListener("click", async () => {
    if (!confirm("Ungroup all active Chrome tab groups?\n\nTabs stay open — they just won't be grouped anymore. Your saved groups in TabGroup Master are not affected.")) return;
    const res = await sendMsg({ action: "closeAllChromeGroups" });
    if (res?.ok) showToast(`Cleared ${res.count} Chrome group(s) — tabs still open`, "success");
    else showToast(res?.error || "Could not clear groups", "error");
  });

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
  document.getElementById("add-tab-btn")?.addEventListener("click", addEditTab);
  document.getElementById("new-tab-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addEditTab(); }
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
