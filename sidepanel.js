// ─── TabGroup Master — Side Panel Script ───

const CHROME_COLORS = [
  "grey", "blue", "red", "yellow", "green",
  "pink", "purple", "cyan", "orange",
];

const COLOR_HEX = {
  grey: "#5f6368", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663",
  green: "#81c995", pink: "#f48fb1", purple: "#d7aefb", cyan: "#78d9ec", orange: "#fcad70",
};

let state = {
  savedGroups: [],
  folders: [],
  conflicts: [],
  importMode: false,
  searchQuery: "",
  editingGroupUid: null,
  activeTab: "active",
  // Normalized O(1) indexes rebuilt after every loadData()
  groupIndex: new Map(),   // uid -> group
  conflictIndex: new Map(), // uid -> conflict
};

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  bindStaticListeners();
  MacroWizard.init({
    showToast,
    onImportModeEnabled: async () => {
      state.importMode = true;
      updateImportToggle();
    },
    onComplete: async () => {
      await loadData();
      render();
    },
  });
  render();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.folders || changes.conflicts || changes.importMode) {
    await loadData();
    render();
  }
});

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message || message.type !== "STORE_UPDATED") return;
  await loadData();
  render();
});

async function loadData() {
  const store = await sendMsg({ action: "getStore" });
  if (!store) return;
  state.savedGroups = store.savedGroups || [];
  state.folders = store.folders || [];
  state.conflicts = store.conflicts || [];
  state.importMode = store.importMode || false;
  buildIndexes();
}

// Build O(1) lookup Maps from flat arrays. Call after every state mutation.
function buildIndexes() {
  state.groupIndex = new Map(state.savedGroups.map((g) => [g.uid, g]));
  state.conflictIndex = new Map(state.conflicts.map((c) => [c.uid, c]));
}

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response);
    });
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".pane").forEach((pane) => pane.classList.add("hidden"));
  const pane = document.getElementById(`pane-${tabName}`);
  if (pane) pane.classList.remove("hidden");
}

function normalizeText(str) {
  return String(str)
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .toLowerCase();
}

function titleMatchesSearch(title, query) {
  if (!query) return true;
  return normalizeText(title || "Unnamed Group").includes(normalizeText(query));
}

function highlightTitle(title, query) {
  const raw = title || "Unnamed Group";
  if (!query) return escHtml(raw);
  const normTitle = normalizeText(raw);
  const normQuery = normalizeText(query);
  const idx = normTitle.indexOf(normQuery);
  if (idx === -1) return escHtml(raw);
  const origMatch = raw.substring(idx, idx + query.length);
  return escHtml(raw.substring(0, idx)) +
    `<span class="search-highlight">${escHtml(origMatch)}</span>` +
    escHtml(raw.substring(idx + query.length));
}

function conflictMatchesSearch(conflict, query) {
  if (!query) return true;
  // O(1) Map lookup instead of O(N) array scan
  const saved = state.groupIndex.get(conflict.savedGroupUid);
  const incomingTitle = conflict.incomingGroup?.title || "";
  const savedTitle = saved ? (saved.title || "") : "";
  return titleMatchesSearch(incomingTitle, query) || titleMatchesSearch(savedTitle, query);
}

function render() {
  renderActivePane();
  renderSavedPane();
  renderConflictsPane();
  updateImportToggle();
  updateConflictBadge();
}

function renderActivePane() {
  const container = document.getElementById("active-groups-list");
  if (!container) return;

  const active = state.savedGroups
    .filter((g) => g.active)
    .filter((g) => titleMatchesSearch(g.title, state.searchQuery));

  document.getElementById("empty-active").classList.toggle("hidden", active.length > 0);

  // Build off-DOM via DocumentFragment — single reflow on append
  const frag = document.createDocumentFragment();
  active.forEach((group, index) => {
    const card = document.createElement("div");
    card.className = "group-card animate-in";
    card.style.animationDelay = `${index * 40}ms`;
    card.innerHTML = buildGroupCardHTML(group);
    bindGroupCardActions(card, group);
    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function buildGroupCardHTML(group) {
  const title = highlightTitle(group.title, state.searchQuery);
  const tabCount = (group.tabs || []).length;
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

function bindGroupCardActions(card, group) {
  card.querySelector(".edit-group-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openEditModal(group);
  });

  card.querySelector(".delete-active-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${group.title || "Unnamed Group"}" permanently?`)) return;
    // Optimistic: remove card from DOM immediately (0 ms perceived latency)
    const cardEl = e.currentTarget.closest(".group-card") || card;
    cardEl.remove();
    state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
    buildIndexes();
    document.getElementById("empty-active")?.classList.toggle("hidden", state.savedGroups.some((g) => g.active));
    showToast("Group deleted", "success");
    // Async persistence — does not block UI
    sendMsg({ action: "deleteGroup", groupUid: group.uid }).then(() => loadData().then(render));
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
    .filter((g) => !g.active && (g.folderId == null))
    .filter((g) => titleMatchesSearch(g.title, state.searchQuery));
}

function updateSavedEmptyState() {
  const empty = document.getElementById("empty-saved");
  if (empty) empty.classList.toggle("hidden", getInboxGroups().length > 0);
}

function renderSavedPane() {
  const container = document.getElementById("saved-groups-list");
  if (!container) return;

  const inbox = getInboxGroups();
  updateSavedEmptyState();

  // Build off-DOM via DocumentFragment — single reflow on append
  const frag = document.createDocumentFragment();
  inbox.forEach((group, index) => {
    const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
    const title = highlightTitle(group.title, state.searchQuery);
    const tabCount = (group.tabs || []).length;

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
      await loadData();
      render();
    });

    card.querySelector(".delete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      // Optimistic: remove from DOM and local state immediately
      const cardEl = e.currentTarget.closest(".saved-group-card") || card;
      cardEl.remove();
      state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
      buildIndexes();
      updateSavedEmptyState();
      showToast("Group deleted", "success");
      // Async persistence
      sendMsg({ action: "deleteGroup", groupUid: group.uid }).then(() => loadData().then(renderSavedPane));
    });

    frag.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(frag);
}

function renderConflictsPane() {
  const container = document.getElementById("conflicts-list");
  if (!container) return;
  container.innerHTML = "";

  const unresolved = state.conflicts
    .filter((c) => !c.resolved)
    .filter((c) => conflictMatchesSearch(c, state.searchQuery));

  document.getElementById("empty-conflicts").classList.toggle("hidden", unresolved.length > 0);

  unresolved.forEach((conflict, index) => {
    // O(1) Map lookup
    const saved = state.groupIndex.get(conflict.savedGroupUid);
    const incoming = conflict.incomingGroup;
    const dot = COLOR_HEX[incoming?.color] || COLOR_HEX.grey;
    const inTitle = highlightTitle(incoming?.title, state.searchQuery);
    const svTitle = highlightTitle(saved ? saved.title : "Deleted", state.searchQuery);
    const inTabs = (incoming?.tabs || []).length;
    const svTabs = saved ? (saved.tabs || []).length : 0;

    const card = document.createElement("div");
    card.className = "conflict-card animate-in";
    card.style.animationDelay = `${index * 45}ms`;
    card.innerHTML = `
      <div class="conflict-header">
        <span class="group-color-dot" style="background:${dot}"></span>
        <div class="conflict-info">
          <div class="conflict-title">Title conflict: <strong>${inTitle}</strong></div>
          <div class="conflict-meta">
            Incoming: ${inTabs} tab${inTabs !== 1 ? "s" : ""} &nbsp;|&nbsp;
            Saved: ${svTitle} (${svTabs} tab${svTabs !== 1 ? "s" : ""})
          </div>
        </div>
      </div>
      <div class="conflict-actions">
        <button class="merge-btn btn-primary" type="button">Merge</button>
        <button class="dismiss-btn btn-secondary" type="button">Dismiss</button>
      </div>`;

    card.querySelector(".merge-btn").addEventListener("click", async () => {
      await sendMsg({ action: "mergeConflict", conflictUid: conflict.uid });
      await loadData();
      render();
      showToast("Groups merged", "success");
    });

    card.querySelector(".dismiss-btn").addEventListener("click", async () => {
      await sendMsg({ action: "dismissConflict", conflictUid: conflict.uid });
      await loadData();
      render();
    });

    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function updateConflictBadge() {
  const count = state.conflicts.filter((c) => !c.resolved).length;
  const badge = document.getElementById("conflict-badge");
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  }
}

function updateImportToggle() {
  const toggle = document.getElementById("import-toggle");
  if (toggle) toggle.checked = state.importMode;
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
  CHROME_COLORS.forEach((c) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (c === selectedColor ? " selected" : "");
    sw.style.background = COLOR_HEX[c];
    sw.dataset.color = c;
    sw.title = c;
    sw.addEventListener("click", () => {
      picker.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      sw.classList.add("selected");
    });
    picker.appendChild(sw);
  });
}

function closeEditModal() {
  state.editingGroupUid = null;
  document.getElementById("edit-modal-overlay").classList.add("hidden");
}

async function confirmEditGroup() {
  const gUid = state.editingGroupUid;
  if (!gUid) return;
  const title = document.getElementById("edit-group-title").value.trim();
  const selectedSwatch = document.querySelector("#edit-color-picker .color-swatch.selected");
  const color = selectedSwatch ? selectedSwatch.dataset.color : undefined;
  const ops = [];
  if (title) ops.push(sendMsg({ action: "updateGroupTitle", groupUid: gUid, title }));
  if (color) ops.push(sendMsg({ action: "updateGroupColor", groupUid: gUid, color }));
  await Promise.all(ops);
  closeEditModal();
  await loadData();
  render();
}

function bindStaticListeners() {
  document.getElementById("btn-open-dashboard")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    render();
  });

  document.querySelector(".info-tooltip")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.getElementById("import-toggle").addEventListener("change", async (e) => {
    state.importMode = e.target.checked;
    await sendMsg({ action: "setImportMode", value: state.importMode });
    await loadData();
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
