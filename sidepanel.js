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

// Storage-event driven updates: reliable regardless of how many extension
// pages are open. Avoids the async-onMessage channel collision that caused
// the native-host port to drop when dashboard + sidepanel were both open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.folders) {
    loadData().then(() => render()).catch(() => {});
  }
});

// onMessage kept only for one-time events that carry extra payload (toasts).
// Non-async so the message channel closes immediately — no stuck channels.
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "RESTORED_FROM_CLOUD") {
    loadData().then(() => {
      render();
      showToast(`♻️ Restored ${message.groupCount} groups from sync backup — open each group once to re-store tab URLs`, "info");
    }).catch(() => {});
  } else if (message.type === "RESTORED_FROM_BACKUP") {
    loadData().then(() => {
      render();
      showToast(`✅ Data restored! ${message.groupCount} groups + ${message.folderCount} folders recovered from local backup.`, "success");
    }).catch(() => {});
  }
  // No return value → channel closes immediately, no response expected.
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

// Match against the group title AND its stored tab titles/URLs, so searching
// "github" finds the group that contains a github.com tab.
function groupMatchesSearch(group, query) {
  if (!query) return true;
  if (titleMatchesSearch(group.title, query)) return true;
  const q = normalizeText(query);
  return (group.tabs || []).some(
    (t) => normalizeText(t.title || "").includes(q) || normalizeText(t.url || "").includes(q)
  );
}

// Find the query inside raw text and return the RAW character range it covers.
// Normalization can change string length (NFD strips diacritics: "café" → "cafe"),
// so we map each normalized char back to the raw index it came from.
function findNormalizedRange(raw, query) {
  const nq = normalizeText(query);
  if (!nq) return null;
  let norm = "";
  const rawIndex = [];
  for (let i = 0; i < raw.length; i++) {
    const piece = normalizeText(raw[i]);
    for (let j = 0; j < piece.length; j++) {
      norm += piece[j];
      rawIndex.push(i);
    }
  }
  const idx = norm.indexOf(nq);
  if (idx === -1) return null;
  return { start: rawIndex[idx], end: rawIndex[idx + nq.length - 1] + 1 };
}

function highlightTitle(title, query) {
  const raw = title || "Unnamed Group";
  if (!query) return escHtml(raw);
  const range = findNormalizedRange(raw, query);
  if (!range) return escHtml(raw);
  return escHtml(raw.substring(0, range.start)) +
    `<span class="search-highlight">${escHtml(raw.substring(range.start, range.end))}</span>` +
    escHtml(raw.substring(range.end));
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
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.className = "group-tab-favicon";
      img.alt = "";
      img.onerror = () => img.remove();
      li.appendChild(img);
    }
    const span = document.createElement("span");
    span.className = "group-tab-text";
    span.textContent = tab.title || tab.url || "Untitled";
    li.appendChild(span);
    li.title = tab.url || "";
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
}

// "3m ago" / "2h ago" / "5d ago" — compact relative timestamp for group cards.
function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
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
  if (!group.tabs.length) {
    list.innerHTML = "<li class=\"group-tab-empty\">Tab URLs not stored — re-capture this group from Chrome to recover them</li>";
    return;
  }
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
    .filter((g) => groupMatchesSearch(g, state.searchQuery));

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
  const trackingBadge = group.openWindowId
    ? `<div class="group-tracking-badge"><span class="tracking-dot"></span>tracking changes</div>`
    : "";
  return `
    <span class="group-color-dot" style="background:${dot}"></span>
    <div class="group-info">
      <div class="group-title">${title} ${inFolder}</div>
      <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
      ${trackingBadge}
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

  card.querySelector(".delete-active-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = group.title || "Unnamed Group";
    const ok = await showModal({
      title: `Delete "${name}"?`,
      body: "Your open Chrome tabs stay open — this only removes the saved entry.",
      confirmText: "Delete", danger: true,
    });
    if (!ok) return;
    const groupSnapshot = { ...group, tabs: [...(group.tabs || [])] };
    (e.currentTarget.closest(".group-card") || card).remove();
    state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
    buildIndexes();
    document.getElementById("empty-active")?.classList.toggle("hidden", state.savedGroups.some((g) => g.active));
    sendMsg({ action: "deleteGroup", groupUid: group.uid });
    showUndoToast(`"${name}" deleted`, () => {
      sendMsg({ action: "restoreDeletedGroup", group: groupSnapshot });
    });
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
    .filter((g) => groupMatchesSearch(g, state.searchQuery));
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
        <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}${group.savedAt ? ` <span class="group-saved-at">· ${timeAgo(group.savedAt)}</span>` : ""}</div>
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

    card.querySelector(".delete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = group.title || "Unnamed Group";
      const count = group.tabCount || (group.tabs || []).length || 0;
      const ok = await showModal({
        title: `Delete "${name}"?`,
        body: `Removes ${count} tab${count !== 1 ? "s" : ""} from your Inbox. Your browser tabs are unaffected.`,
        confirmText: "Delete", danger: true,
      });
      if (!ok) return;
      const groupSnapshot = { ...group, tabs: [...(group.tabs || [])] };
      (e.currentTarget.closest(".saved-group-card") || card).remove();
      state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
      buildIndexes();
      updateSavedEmptyState();
      sendMsg({ action: "deleteGroup", groupUid: group.uid });
      showUndoToast(`"${name}" deleted`, () => {
        sendMsg({ action: "restoreDeletedGroup", group: groupSnapshot });
      });
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
      <input type="checkbox" class="profile-check" value="${escHtml(p.dir)}" />
      <div class="profile-avatar">${escHtml(initial)}</div>
      <div class="profile-info">
        <span class="profile-display-name">${escHtml(p.displayName || p.profileName)}</span>
        ${p.email ? `<span class="profile-email">${escHtml(p.email)}</span>` : ""}
      </div>`;
    list.appendChild(label);
  });
}

// ── Import: show the profile picker, pull only from the chosen profile ──────
// Security: every Chrome profile / account is kept strictly separate.
// Only the profile the user picks is imported from — never all of them.
async function runImport() {
  if (_importing) return;
  _importing = true;
  showImportOverlay();
  setImportStep("loading");
  try {
    const res = await sendMsg({ action: "listChromeProfiles" });
    if (!res?.ok) {
      showToast("❌ Could not reach the native host. Run the installer in the NativeHost folder, then restart your browser.", "error");
      _importing = false;
      hideImportOverlay();
      return;
    }
    const profiles = res.profiles || [];
    if (!profiles.length) {
      showToast("No Chrome profiles found.", "info");
      _importing = false;
      hideImportOverlay();
      return;
    }
    populateProfileList(profiles);
    setImportStep("picker");
    // _importing stays true until the user makes a selection
  } catch (e) {
    showToast("❌ " + (e?.message || "Connection error"), "error");
    _importing = false;
    hideImportOverlay();
  }
}

// btn-picker-confirm: import only from the selected profiles
async function doImport(profileDirs) {
  // Security: never import from all profiles. Require an explicit selection.
  if (!Array.isArray(profileDirs) || !profileDirs.length) {
    showToast("⚠️ Select a profile first — only the account you pick is imported.", "info");
    return;
  }
  setImportStep("importing");
  try {
    const res = await sendMsg({ action: "importFromChrome", profileDirs });
    if (res?.ok) {
      await loadData();
      render();
      showToast(`✅ Imported ${res.added} new group${res.added !== 1 ? "s" : ""}${res.total ? ` (${res.total} found)` : ""}`, "success");
    } else {
      showToast("❌ " + (res?.error || "Import failed"), "error");
    }
  } catch (e) {
    showToast("❌ " + (e?.message || "Import failed"), "error");
  } finally {
    _importing = false;
    hideImportOverlay();
  }
}

async function handleImportFiles(fileList) {
  if (_importing) return;
  if (!fileList || !fileList.length) return; // cancelled
  if (!window.ChromeGroupImport) {
    showToast("Importer not loaded — reopen the panel.", "error");
    return;
  }
  _importing = true;
  setImportStep("importing");
  showImportOverlay();
  try {
    const { savedGroups, folders } = await window.ChromeGroupImport.importFromFileList(fileList);
    if (!savedGroups.length) {
      showToast("No saved tab groups found in that folder.", "info");
      return;
    }
    const res = await sendMsg({ action: "importJson", data: { savedGroups, folders } });
    if (res?.ok) {
      await loadData();
      render();
      const msg = res.added > 0
        ? `Imported ${res.added} new group${res.added !== 1 ? "s" : ""} (${savedGroups.length} found)`
        : `No new groups — ${savedGroups.length} already imported`;
      showToast(msg, res.added > 0 ? "success" : "info");
    } else {
      showToast("Import failed while saving.", "error");
    }
  } catch (e) {
    showToast(e?.message || "Import failed", "error");
  } finally {
    _importing = false;
    hideImportOverlay();
  }
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
  const g = state.savedGroups.length;
  const f = state.folders.length;
  const ok = await showModal({
    title: "Nuke everything?",
    body: `This permanently deletes all ${g} group${g !== 1 ? "s" : ""} and ${f} folder${f !== 1 ? "s" : ""}. Export a JSON backup first if you want to recover later.`,
    confirmText: "Yes, nuke it", cancelText: "Cancel", danger: true, icon: "💥",
  });
  if (!ok) return;
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
  document.getElementById("sp-dir-input")?.addEventListener("change", (e) => {
    const files = e.target.files;
    e.target.value = "";
    handleImportFiles(files);
  });

  document.getElementById("btn-new-group")?.addEventListener("click", () => openEditModal(null));

  document.getElementById("btn-save-window")?.addEventListener("click", async () => {
    const name = await showModal({
      title: "Save This Window",
      body: "All tabs in this window will be saved as a new group. You can rename it anytime.",
      confirmText: "Save", cancelText: "Cancel", icon: "💾",
      inputConfig: { placeholder: "Group name (optional)", value: "" },
    });
    if (name === null) return;
    const win = await chrome.windows.getCurrent();
    const res = await sendMsg({ action: "saveWindowAsGroup", windowId: win.id, title: name });
    if (res?.ok) {
      showToast(`Saved ${res.tabCount} tab${res.tabCount !== 1 ? "s" : ""} — changes tracked until window closes`, "success");
    } else {
      showToast(res?.error || "Could not save window", "error");
    }
  });

  document.getElementById("btn-picker-cancel")?.addEventListener("click", () => {
    _importing = false;
    hideImportOverlay();
  });

  document.getElementById("btn-picker-confirm")?.addEventListener("click", async () => {
    const checked = [...document.querySelectorAll(".profile-check:checked")];
    const dirs = checked.map((cb) => cb.value).filter(Boolean);
    // Security: if no profile is selected, import NOTHING (importing from all is forbidden).
    if (!dirs.length) {
      showToast("⚠️ Select a profile first — only the account you pick is imported.", "info");
      return;
    }
    await doImport(dirs);
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

// ── Custom modal (replaces browser confirm / prompt) ─────────────────────────
function showModal({ title, body = "", confirmText = "Confirm", cancelText = "Cancel", danger = false, icon = null, inputConfig = null }) {
  return new Promise((resolve) => {
    const overlay   = document.getElementById("sp-confirm-overlay");
    const iconEl    = document.getElementById("sp-confirm-icon");
    const titleEl   = document.getElementById("sp-confirm-title");
    const bodyEl    = document.getElementById("sp-confirm-body");
    const inputWrap = document.getElementById("sp-confirm-input-wrap");
    const inputEl   = document.getElementById("sp-confirm-input");
    const okBtn     = document.getElementById("sp-confirm-ok");
    const cancelBtn = document.getElementById("sp-confirm-cancel");

    iconEl.textContent   = icon || (danger ? "🗑️" : inputConfig ? "💾" : "⚠️");
    titleEl.textContent = title;
    // Escape first: body strings interpolate group/profile names, which must
    // never be parsed as HTML (XSS in an extension page = full API access).
    bodyEl.innerHTML = escHtml(body).replace(/\n/g, "<br>");
    okBtn.textContent    = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = "sp-confirm-btn sp-confirm-ok" + (danger ? " sp-confirm-danger" : "");

    if (inputConfig) {
      inputWrap.classList.remove("hidden");
      inputEl.placeholder = inputConfig.placeholder || "";
      inputEl.value       = inputConfig.value || "";
      setTimeout(() => { inputEl.focus(); inputEl.select(); }, 60);
    } else {
      inputWrap.classList.add("hidden");
    }

    overlay.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("sp-confirm-visible")));

    let done = false;
    const close = (result) => {
      if (done) return; done = true;
      overlay.classList.remove("sp-confirm-visible");
      setTimeout(() => overlay.classList.add("hidden"), 200);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onBg);
      resolve(result);
    };
    const onOk     = () => close(inputConfig ? inputEl.value : true);
    const onCancel = () => close(inputConfig ? null : false);
    const onKey    = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter")  { e.preventDefault(); onOk(); }
    };
    const onBg = (e) => { if (e.target === overlay) onCancel(); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onBg);
  });
}

const TOAST_MAX = 5;
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container || !message) return;
  // FIFO: if at max capacity, immediately drop the oldest toast
  const existing = container.querySelectorAll(".toast");
  if (existing.length >= TOAST_MAX) {
    const oldest = existing[0];
    oldest.classList.remove("toast-visible");
    oldest.classList.add("toast-out");
    setTimeout(() => oldest.remove(), 300);
  }
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

function showUndoToast(message, onUndo) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const existing = container.querySelectorAll(".toast");
  if (existing.length >= TOAST_MAX) {
    const oldest = existing[0];
    oldest.classList.remove("toast-visible");
    oldest.classList.add("toast-out");
    setTimeout(() => oldest.remove(), 300);
  }
  const toast = document.createElement("div");
  toast.className = "toast toast-warning toast-with-action";
  const span = document.createElement("span");
  span.textContent = message;
  const btn = document.createElement("button");
  btn.className = "toast-undo-btn";
  btn.textContent = "Undo";
  toast.appendChild(span);
  toast.appendChild(btn);
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("toast-visible")));
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 400);
  };
  const timer = setTimeout(dismiss, 8000);
  btn.addEventListener("click", () => {
    clearTimeout(timer);
    dismiss();
    onUndo();
  });
}
