// ─── TabGroup Master — Side Panel Script ───

// ─── Constants ───────────────────────────────────────────────────────────────

const CHROME_COLORS = [
  "grey", "blue", "red", "yellow", "green",
  "pink", "purple", "cyan", "orange"
];

const COLOR_HEX = {
  grey:   "#5f6368",
  blue:   "#8ab4f8",
  red:    "#f28b82",
  yellow: "#fdd663",
  green:  "#81c995",
  pink:   "#f48fb1",
  purple: "#d7aefb",
  cyan:   "#78d9ec",
  orange: "#fcad70",
};

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  savedGroups:   [],   // [{uid, title, color, tabs, active, chromeGroupId}]
  categories:    [],   // [{id, name, groupUids:[], collapsed}]
  conflicts:     [],   // [{uid, incomingGroup, savedGroupUid, resolved}]
  importMode:    false,
  searchQuery:   "",
  editingGroupUid: null,
  activeTab:     "active",
};

let dragSrcGroupUid    = null;
let dragSrcCategoryId  = null;
let macroScanAbort     = false;
let macroScanRunning   = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  bindStaticListeners();
  render();
});

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadData() {
  const store = await sendMsg({ action: "getStore" });
  if (!store) return;
  state.savedGroups = store.savedGroups || [];
  state.categories  = store.categories  || [];
  state.conflicts   = store.conflicts   || [];
  state.importMode  = store.importMode  || false;

  // Prune dead refs from categories
  const liveUids = new Set(state.savedGroups.map((g) => g.uid));
  state.categories.forEach((cat) => {
    cat.groupUids = (cat.groupUids || []).filter((u) => liveUids.has(u));
  });
}

async function persistCategories() {
  await sendMsg({ action: "saveCategories", categories: state.categories });
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response);
    });
  });
}

// ─── Live Sync ────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.categories || changes.conflicts || changes.importMode) {
    await loadData();
    render();
  }
});

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message || !message.type) return;

  if (message.type === "MACRO_RESULT") {
    if (message.status === "SUCCESS") showToast("Auto-Scan completed!", "success");
    else if (message.status === "STOPPED") showToast("Scan aborted", "error");
    else if (message.error) showToast(message.error, "error");
    await loadData();
    render();
    return;
  }

  await loadData();
  render();
});

// ─── Tab Switching ────────────────────────────────────────────────────────────

function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  document.querySelectorAll(".pane").forEach((pane) => {
    pane.classList.add("hidden");
  });
  const pane = document.getElementById(`pane-${tabName}`);
  if (pane) pane.classList.remove("hidden");
}

// ─── Turkish-Aware Search ─────────────────────────────────────────────────────

function normalizeText(str) {
  return String(str)
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .replace(/ı/g, "i")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .toLowerCase();
}

function buildNormalizedMap(str) {
  const chars = [...str];
  let normalized = "";
  const indexMap = [];
  for (let i = 0; i < chars.length; i++) {
    const n = normalizeText(chars[i]);
    for (let j = 0; j < n.length; j++) {
      indexMap.push(i);
      normalized += n[j];
    }
  }
  return { normalized, indexMap, chars };
}

function fuzzyMatch(str, query) {
  if (!query) return true;
  const s = normalizeText(str || "");
  const q = normalizeText(query);
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function titleMatchesSearch(title, query) {
  if (!query) return true;
  const normTitle = normalizeText(title || "Unnamed Group");
  const normQuery = normalizeText(query);
  return normTitle.includes(normQuery);
}

function conflictMatchesSearch(conflict, query) {
  if (!query) return true;
  const saved = state.savedGroups.find((g) => g.uid === conflict.savedGroupUid);
  const incomingTitle = conflict.incomingGroup?.title || "";
  const savedTitle = saved ? (saved.title || "") : "";
  return fuzzyMatch(incomingTitle, query) || fuzzyMatch(savedTitle, query);
}

function highlightTitle(title, query) {
  const raw = title || "Unnamed Group";
  if (!query) return escHtml(raw);

  const { normalized, indexMap, chars } = buildNormalizedMap(raw);
  const normQuery = normalizeText(query);
  if (!normQuery) return escHtml(raw);

  const start = normalized.indexOf(normQuery);
  if (start === -1) return escHtml(raw);

  const end = start + normQuery.length;
  const origStart = indexMap[start];
  const origEnd = indexMap[end - 1] + 1;

  const before = escHtml(chars.slice(0, origStart).join(""));
  const match  = escHtml(chars.slice(origStart, origEnd).join(""));
  const after  = escHtml(chars.slice(origEnd).join(""));
  return `${before}<span class="search-highlight">${match}</span>${after}`;
}

function filteredActiveGroups() {
  const active = state.savedGroups.filter((g) => g.active);
  if (!state.searchQuery) return active;
  return active.filter((g) =>
    titleMatchesSearch(g.title, state.searchQuery)
  );
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderActivePane();
  renderSavedPane();
  renderConflictsPane();
  updateImportToggle();
  updateConflictBadge();
}

// ─── Active Pane ──────────────────────────────────────────────────────────────

function renderActivePane() {
  const visible = filteredActiveGroups();
  const categorizedUids = new Set(
    state.categories.flatMap((c) => c.groupUids || [])
  );
  const uncategorized = visible.filter((g) => !categorizedUids.has(g.uid));

  renderCategories(visible);
  renderUncategorized(uncategorized);

  document.getElementById("empty-active").classList.toggle("hidden", visible.length > 0);
  document.getElementById("uncategorized-section").classList.toggle(
    "hidden",
    uncategorized.length === 0
  );
}

function renderCategories(visibleGroups) {
  const container = document.getElementById("categories-list");
  container.innerHTML = "";
  const visibleUids = new Set(visibleGroups.map((g) => g.uid));

  state.categories.forEach((cat, index) => {
    const catGroups = (cat.groupUids || [])
      .map((uid) => state.savedGroups.find((g) => g.uid === uid))
      .filter((g) => g && visibleUids.has(g.uid));

    if (state.searchQuery && catGroups.length === 0) return;

    const card = document.createElement("div");
    card.className = "category-card animate-in" + (cat.collapsed ? " collapsed" : "");
    card.style.animationDelay = `${index * 55}ms`;
    card.dataset.catId = cat.id;

    card.innerHTML = `
      <div class="category-header">
        <div class="category-header-left">
          <svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          <span class="category-name" title="${escHtml(cat.name)}">${escHtml(cat.name)}</span>
          <span class="category-count">${catGroups.length}</span>
        </div>
        <div class="category-actions">
          <button class="rename-cat-btn" title="Rename category">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="delete-cat-btn delete-btn" title="Delete category">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="category-body groups-container" data-cat-id="${cat.id}">
        ${catGroups.map(buildGroupCardHTML).join("")}
        ${catGroups.length === 0 ? `<div style="padding:8px 4px;color:var(--text-muted);font-size:11.5px;text-align:center;">Drop groups here</div>` : ""}
      </div>`;

    card.querySelector(".category-header").addEventListener("click", (e) => {
      if (e.target.closest(".category-actions")) return;
      cat.collapsed = !cat.collapsed;
      card.classList.toggle("collapsed", cat.collapsed);
      persistCategories();
    });

    card.querySelector(".rename-cat-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineRename(cat, card);
    });

    card.querySelector(".delete-cat-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      state.categories = state.categories.filter((c) => c.id !== cat.id);
      persistCategories();
      render();
    });

    const body = card.querySelector(".category-body");
    bindDropZone(body, cat.id);
    bindGroupCardListeners(body);

    container.appendChild(card);
  });
}

function renderUncategorized(groups) {
  const container = document.getElementById("uncategorized-groups");
  container.innerHTML = groups.map(buildGroupCardHTML).join("");
  bindDropZone(container, null);
  bindGroupCardListeners(container);
}

// ─── Group Card HTML (active groups) ─────────────────────────────────────────

function buildGroupCardHTML(group) {
  const title    = highlightTitle(group.title, state.searchQuery);
  const tabCount = (group.tabs || []).length;
  const dot      = COLOR_HEX[group.color] || COLOR_HEX.grey;
  return `
    <div class="group-card animate-in" draggable="true" data-group-uid="${group.uid}">
      <span class="group-color-dot" style="background:${dot}"></span>
      <div class="group-info">
        <div class="group-title">${title}</div>
        <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
      </div>
      <div class="group-actions">
        <button class="edit-group-btn" title="Edit group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="toggle-group-btn" title="Collapse/Expand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
        </button>
      </div>
    </div>`;
}

// ─── Group Card Listeners (active) ───────────────────────────────────────────

function bindGroupCardListeners(container) {
  container.querySelectorAll(".group-card").forEach((card) => {
    const groupUid = card.dataset.groupUid;
    const group    = state.savedGroups.find((g) => g.uid === groupUid);
    if (!group) return;

    card.addEventListener("dragstart", (e) => {
      dragSrcGroupUid    = groupUid;
      dragSrcCategoryId  = findGroupCategory(groupUid);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragSrcGroupUid   = null;
      dragSrcCategoryId = null;
      document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over"));
    });

    card.querySelector(".edit-group-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(group);
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
  });
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function bindDropZone(element, targetCategoryId) {
  element.addEventListener("dragover", (e) => {
    if (dragSrcGroupUid === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    element.classList.add("drop-over");
  });

  element.addEventListener("dragleave", () => {
    element.classList.remove("drop-over");
  });

  element.addEventListener("drop", (e) => {
    e.preventDefault();
    element.classList.remove("drop-over");
    if (dragSrcGroupUid === null) return;
    if (dragSrcCategoryId === targetCategoryId) return;

    if (dragSrcCategoryId !== null) {
      const srcCat = state.categories.find((c) => c.id === dragSrcCategoryId);
      if (srcCat) srcCat.groupUids = srcCat.groupUids.filter((u) => u !== dragSrcGroupUid);
    }

    if (targetCategoryId !== null) {
      const tgtCat = state.categories.find((c) => c.id === targetCategoryId);
      if (tgtCat && !(tgtCat.groupUids || []).includes(dragSrcGroupUid)) {
        tgtCat.groupUids = tgtCat.groupUids || [];
        tgtCat.groupUids.push(dragSrcGroupUid);
      }
    }

    persistCategories();
    render();
  });
}

function findGroupCategory(groupUid) {
  const cat = state.categories.find((c) => (c.groupUids || []).includes(groupUid));
  return cat ? cat.id : null;
}

// ─── Saved Pane ───────────────────────────────────────────────────────────────

function renderSavedPane() {
  const container = document.getElementById("saved-groups-list");
  container.innerHTML = "";

  const inactive = state.savedGroups
    .filter((g) => !g.active)
    .filter((g) => fuzzyMatch(g.title || "Unnamed Group", state.searchQuery));

  document.getElementById("empty-saved").classList.toggle("hidden", inactive.length > 0);

  inactive.forEach((group, index) => {
    const dot      = COLOR_HEX[group.color] || COLOR_HEX.grey;
    const title    = highlightTitle(group.title, state.searchQuery);
    const tabCount = (group.tabs || []).length;

    const card = document.createElement("div");
    card.className = "group-card saved-group-card animate-in";
    card.style.animationDelay = `${index * 45}ms`;
    card.innerHTML = `
      <span class="group-color-dot" style="background:${dot}"></span>
      <div class="group-info">
        <div class="group-title">${title}</div>
        <div class="group-tab-count">${tabCount} tab${tabCount !== 1 ? "s" : ""}</div>
      </div>
      <div class="group-actions">
        <button class="restore-btn" title="Restore group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
          </svg>
        </button>
        <button class="delete-btn" title="Delete group">
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
      else if (res?.error) showToast(res.error, "error");
      await loadData();
      render();
    });

    card.querySelector(".delete-btn").addEventListener("click", async () => {
      const res = await sendMsg({ action: "deleteGroup", groupUid: group.uid });
      if (res?.ok) showToast("Group deleted", "success");
      else if (res?.error) showToast(res.error, "error");
      await loadData();
      render();
    });

    container.appendChild(card);
  });
}

// ─── Conflicts Pane ───────────────────────────────────────────────────────────

function renderConflictsPane() {
  const container = document.getElementById("conflicts-list");
  container.innerHTML = "";

  const unresolved = state.conflicts
    .filter((c) => !c.resolved)
    .filter((c) => conflictMatchesSearch(c, state.searchQuery));

  document.getElementById("empty-conflicts").classList.toggle("hidden", unresolved.length > 0);

  unresolved.forEach((conflict, index) => {
    const saved    = state.savedGroups.find((g) => g.uid === conflict.savedGroupUid);
    const incoming = conflict.incomingGroup;
    const dot      = COLOR_HEX[incoming.color] || COLOR_HEX.grey;
    const inTitle  = highlightTitle(incoming.title, state.searchQuery);
    const svTitle  = highlightTitle(saved ? saved.title : "Deleted Group", state.searchQuery);
    const inTabs   = (incoming.tabs || []).length;
    const svTabs   = saved ? (saved.tabs || []).length : 0;

    const card = document.createElement("div");
    card.className = "conflict-card animate-in";
    card.style.animationDelay = `${index * 50}ms`;
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
        <button class="merge-btn btn-primary" title="Merge tabs (deduplicate by URL)">Merge</button>
        <button class="dismiss-btn btn-secondary" title="Keep saved, discard incoming">Dismiss</button>
      </div>`;

    card.querySelector(".merge-btn").addEventListener("click", async () => {
      const res = await sendMsg({ action: "mergeConflict", conflictUid: conflict.uid });
      if (res?.ok) showToast("Groups merged", "success");
      else if (res?.error) showToast(res.error, "error");
      await loadData();
      render();
    });

    card.querySelector(".dismiss-btn").addEventListener("click", async () => {
      await sendMsg({ action: "dismissConflict", conflictUid: conflict.uid });
      await loadData();
      render();
    });

    container.appendChild(card);
  });
}

// ─── Conflict Badge ───────────────────────────────────────────────────────────

function updateConflictBadge() {
  const count  = state.conflicts.filter((c) => !c.resolved).length;
  const badge  = document.getElementById("conflict-badge");
  badge.textContent = count;
  badge.classList.toggle("hidden", count === 0);
}

// ─── Import Mode Toggle ───────────────────────────────────────────────────────

function updateImportToggle() {
  const toggle = document.getElementById("import-toggle");
  if (toggle) toggle.checked = state.importMode;
}

// ─── Inline Category Rename ───────────────────────────────────────────────────

function startInlineRename(cat, cardEl) {
  const nameEl  = cardEl.querySelector(".category-name");
  const current = cat.name;
  const input   = document.createElement("input");
  input.className = "inline-rename";
  input.value     = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      cat.name = newName;
      persistCategories();
      showToast("Category renamed", "success");
    } else if (newName) {
      persistCategories();
    }
    render();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  commit();
    if (e.key === "Escape") render();
  });
  input.addEventListener("blur", commit);
}

// ─── Edit Group Modal ─────────────────────────────────────────────────────────

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
    sw.className     = "color-swatch" + (c === selectedColor ? " selected" : "");
    sw.style.background = COLOR_HEX[c];
    sw.dataset.color = c;
    sw.title         = c;
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
  const title          = document.getElementById("edit-group-title").value.trim();
  const selectedSwatch = document.querySelector("#edit-color-picker .color-swatch.selected");
  const color          = selectedSwatch ? selectedSwatch.dataset.color : undefined;

  const ops = [];
  if (title) ops.push(sendMsg({ action: "updateGroupTitle", groupUid: gUid, title }));
  if (color) ops.push(sendMsg({ action: "updateGroupColor", groupUid: gUid, color }));
  await Promise.all(ops);
  closeEditModal();
  await loadData();
  render();
}

// ─── Macro Guide Modal ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetMacroGuideModal() {
  macroScanAbort   = false;
  macroScanRunning = false;
  document.getElementById("macro-countdown").textContent = "";
  document.getElementById("macro-countdown").classList.remove("pulse");
  const status = document.getElementById("macro-scan-status");
  status.textContent = "";
  status.classList.add("hidden");
  status.classList.remove("scanning");
  document.getElementById("macro-guide-actions").classList.remove("hidden");
}

function openMacroGuideModal() {
  resetMacroGuideModal();
  document.getElementById("macro-guide-modal").classList.remove("hidden");
}

function closeMacroGuideModal() {
  macroScanAbort = true;
  document.getElementById("macro-guide-modal").classList.add("hidden");
  resetMacroGuideModal();
}

async function startMacroScan() {
  if (macroScanRunning) return;
  macroScanAbort   = false;
  macroScanRunning = true;

  const countdownEl = document.getElementById("macro-countdown");
  const statusEl    = document.getElementById("macro-scan-status");
  const actionsEl   = document.getElementById("macro-guide-actions");

  actionsEl.classList.add("hidden");
  statusEl.classList.add("hidden");
  statusEl.classList.remove("scanning");
  countdownEl.textContent = "";

  for (let i = 3; i >= 1; i--) {
    if (macroScanAbort) {
      macroScanRunning = false;
      return;
    }
    countdownEl.textContent = String(i);
    countdownEl.classList.remove("pulse");
    void countdownEl.offsetWidth;
    countdownEl.classList.add("pulse");
    await sleep(1000);
  }

  if (macroScanAbort) {
    macroScanRunning = false;
    return;
  }

  countdownEl.textContent = "";
  statusEl.textContent =
    "Scanning in progress... Please DO NOT move your mouse. Press Ctrl+Q or move to screen corner to abort.";
  statusEl.classList.remove("hidden");
  statusEl.classList.add("scanning");

  const res = await sendMsg({ action: "runNativeMacro" });

  macroScanRunning = false;
  closeMacroGuideModal();

  if (res?.ok) {
    const status = res.response?.status;
    if (status === "SUCCESS") showToast("Auto-Scan completed!", "success");
    else if (status === "STOPPED") showToast("Scan aborted", "error");
    else showToast("Auto-Scan completed!", "success");
    await loadData();
    render();
  } else if (res?.error) {
    showToast(res.error, "error");
  }
}

// ─── Static Listeners ─────────────────────────────────────────────────────────

function bindStaticListeners() {
  document.getElementById("btn-open-dashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  // Tab bar
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Global search (all tabs)
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    render();
  });

  document.querySelector(".info-tooltip")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // Import Mode toggle
  document.getElementById("import-toggle").addEventListener("change", async (e) => {
    state.importMode = e.target.checked;
    await sendMsg({ action: "setImportMode", value: state.importMode });
    await loadData();
    render();
  });

  // Edit group modal
  document.getElementById("edit-modal-cancel").addEventListener("click", closeEditModal);
  document.getElementById("edit-modal-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEditModal();
  });
  document.getElementById("edit-modal-confirm").addEventListener("click", confirmEditGroup);
  document.getElementById("edit-group-title").addEventListener("keydown", (e) => {
    if (e.key === "Enter")  confirmEditGroup();
    if (e.key === "Escape") closeEditModal();
  });

  document.getElementById("btn-run-macro").addEventListener("click", () => {
    openMacroGuideModal();
  });

  document.getElementById("macro-start-btn").addEventListener("click", () => {
    startMacroScan();
  });

  document.getElementById("macro-cancel-btn").addEventListener("click", () => {
    closeMacroGuideModal();
  });

  document.getElementById("macro-guide-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget && !macroScanRunning) closeMacroGuideModal();
  });
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container || !message) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("toast-visible"));
  });

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
