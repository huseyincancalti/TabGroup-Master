// ─── TabGroup Master — Dashboard ───

const COLOR_HEX = {
  grey: "#5f6368", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663",
  green: "#81c995", pink: "#f48fb1", purple: "#d7aefb", cyan: "#78d9ec", orange: "#fcad70",
};

const INBOX_PAGE_SIZE = 200; // Show up to 200 groups before "Show more"

let state = {
  savedGroups: [],
  folders: [],
  activeView: "overview",
  groupIndex: new Map(),
  folderIndex: new Map(),
  childFoldersByParent: new Map(),
  childGroupsByFolder: new Map(),
  inboxGroups: [],
  inboxFilter: "",
  inboxPage: 0,
  cleanupFilter: "",
  wsFilter: "",
};

let modalContext = null;
const sortableInstances = [];

document.addEventListener("DOMContentLoaded", async () => {
  // Show extension ID in diagnostics panel
  const extIdEl = document.getElementById("diag-ext-id");
  if (extIdEl) extIdEl.textContent = chrome.runtime.id;

  await loadData();
  bindListeners();
  await loadSettings();
  render();
  checkRecoveryOffer();

  // Deep-link: dashboard.html#settings jumps straight to the Settings view.
  if (location.hash === "#settings" && typeof switchView === "function") {
    switchView("settings");
  }
});

let _importBusy = false;

async function _runBrowserImport(getResult) {
  if (_importBusy) return;
  if (!window.ChromeGroupImport) {
    showToast("Importer not loaded — reload the page.", "error");
    return;
  }
  _importBusy = true;
  const dz = document.getElementById("drop-zone");
  dz?.classList.add("drop-zone-busy");
  try {
    const { savedGroups, folders } = await getResult();
    if (!savedGroups.length) {
      showToast("No saved tab groups found there.", "info");
      return;
    }
    const res = await sendMsg({ action: "importJson", data: { savedGroups, folders } });
    if (res?.ok) {
      await loadData();
      render();
      showToast(
        `Imported ${res.added} new group${res.added !== 1 ? "s" : ""} (${savedGroups.length} found)`,
        "success"
      );
    } else {
      showToast("Import failed while saving.", "error");
    }
  } catch (e) {
    if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) return; // cancelled
    const msg = e?.message || "Import failed";
    const isBlocked = msg.includes("BLOCKED") || msg.toLowerCase().includes("blocked");
    showToast(
      isBlocked
        ? "⛔ Chrome blocked access — copy the LevelDB folder to Desktop first (see Step 1)"
        : msg,
      "error",
      isBlocked ? 7000 : 4000
    );
  } finally {
    _importBusy = false;
    dz?.classList.remove("drop-zone-busy");
  }
}

function importFromBrowserFolder(fileList) {
  if (!fileList || !fileList.length) return; // chooser cancelled
  return _runBrowserImport(() => window.ChromeGroupImport.importFromFileList(fileList));
}

function importFromDataTransfer(dataTransfer) {
  return _runBrowserImport(() => window.ChromeGroupImport.importFromDataTransfer(dataTransfer));
}

async function loadSettings() {
  const res = await sendMsg({ action: "getSettings" });
  const s = res?.settings || {};
  const lazyEl = document.getElementById("toggle-lazy-restore");
  const freeEl = document.getElementById("toggle-free-mode");
  if (lazyEl) lazyEl.checked = s.lazyRestore !== false;
  if (freeEl) freeEl.checked = s.freeMode !== false;
}

// Storage-event driven updates: reliable regardless of how many extension
// pages are open. Avoids the async-onMessage channel collision that caused
// the native-host port to drop when dashboard + sidepanel were both open.
// While the user is dragging (and just after a drop) we skip the re-render that
// our own storage writes would trigger — SortableJS has already placed the node
// exactly where it was dropped, so re-rendering would only cause a scroll jump
// and undo the placement.
let _suppressTreeRenderUntil = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.savedGroups || changes.folders) {
    if (Date.now() < _suppressTreeRenderUntil) return;
    loadData().then(() => render()).catch(() => {});
  }
});

// onMessage kept only for one-time events that carry extra payload (toasts).
// Non-async so the message channel closes immediately — no stuck channels.
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "RESTORED_FROM_BACKUP") {
    loadData().then(() => {
      render();
      showToast(`✅ Data restored! ${message.groupCount} groups + ${message.folderCount} folders recovered from local backup.`, "success");
    }).catch(() => {});
  }
  // No return value → channel closes immediately, no response expected.
});

function sendMsg(message) {
  // Retry up to 3 times with 400 ms gaps — guards against SW wake-up latency
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
  // Read straight from chrome.storage.local — instant source of truth, so the
  // dashboard paints without waiting on a possibly-cold MV3 service worker.
  // The SW is only needed for mutations; storage.onChanged re-syncs after them.
  let store;
  try {
    const raw = await chrome.storage.local.get(["savedGroups", "folders"]);
    store = { savedGroups: raw.savedGroups || [], folders: raw.folders || [] };
  } catch (_) {
    store = await sendMsg({ action: "getStore" });
  }
  if (!store) return;

  state.savedGroups = (store.savedGroups || []).map((g) => ({
    ...g,
    folderId: g.folderId ?? null,
  }));
  state.folders = (store.folders || []).map((f) => ({
    ...f,
    parentId: f.parentId ?? null,
    isExpanded: f.isExpanded !== false,
  }));
  buildIndexes();
}

// Rebuild all O(1) lookup indexes from the flat arrays.
// Must be called after any in-place state mutation.
function getGroupTabCount(group) {
  if (typeof group.tabCount === "number") return group.tabCount;
  return (group.tabs || []).length;
}

function buildIndexes() {
  state.groupIndex = new Map(state.savedGroups.map((g) => [g.uid, g]));
  state.folderIndex = new Map(state.folders.map((f) => [f.id, f]));

  state.childFoldersByParent = new Map();
  state.childGroupsByFolder = new Map();
  state.inboxGroups = [];

  for (const f of state.folders) {
    const key = f.parentId ?? "__root__";
    if (!state.childFoldersByParent.has(key)) state.childFoldersByParent.set(key, []);
    state.childFoldersByParent.get(key).push(f);
  }

  for (const g of state.savedGroups) {
    if (g.folderId) {
      if (!state.childGroupsByFolder.has(g.folderId)) state.childGroupsByFolder.set(g.folderId, []);
      state.childGroupsByFolder.get(g.folderId).push(g);
    } else if (!g.active) {
      state.inboxGroups.push(g);
    }
  }
}

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".dashboard-view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${view}`);
  });
  if (view === "workspace") {
    renderTree();
  } else if (view === "cleanup") {
    renderCleanup();
  } else if (view === "overview") {
    renderOverviewStats();
  }
}

function normalizeText(str) {
  return String(str)
    // Turkish dotless-i has no NFD decomposition — must be explicit
    .replace(/İ/g, "i").replace(/ı/g, "i")
    // NFD strips all other diacritics: ç→c, ü→u, é→e, ñ→n, Ö→O→o …
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Match against the group title AND its stored tab titles/URLs, so searching
// "github" finds the group that contains a github.com tab. `q` must already
// be normalized via normalizeText().
function groupMatchesQuery(group, q) {
  if (!q) return true;
  if (normalizeText(group.title || "unnamed group").includes(q)) return true;
  return (group.tabs || []).some(
    (t) => normalizeText(t.title || "").includes(q) || normalizeText(t.url || "").includes(q)
  );
}

function render() {
  renderOverviewStats();
  const view = state.activeView;
  // Check both state flag AND actual DOM class (state can lag on first load)
  const workspaceActive = view === "workspace"
    || document.getElementById("view-workspace")?.classList.contains("active");
  if (workspaceActive) {
    renderTree();
  } else if (view === "cleanup") {
    renderCleanup();
  }
}

function renderOverviewStats() {
  const total    = state.savedGroups.length;
  const active   = state.savedGroups.filter((g) => g.active).length;
  const inbox    = state.inboxGroups.length;
  const folders  = state.folders.length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set("stat-total",   total);
  set("stat-active",  active);
  set("stat-inbox",   inbox);
  set("stat-folders", folders);
}

function isRootParent(parentId) {
  return parentId == null || parentId === "";
}

// O(1) index-backed lookups — replace former O(N) array filters
function getChildFolders(parentId) {
  const key = parentId ?? "__root__";
  return (state.childFoldersByParent.get(key) || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Groups keep the order they sit in `savedGroups` (which buildIndexes preserves)
// rather than being force-sorted alphabetically — so when you drag a group to a
// spot, it STAYS there instead of jumping to an alphabetical position.
function getChildGroups(folderId) {
  return (state.childGroupsByFolder.get(folderId) || []).slice();
}

function getInboxGroups() {
  return (state.inboxGroups || []).slice();
}

function resolveTargetFolderId(folderIdAttr) {
  if (!folderIdAttr || folderIdAttr === "root" || folderIdAttr === "inbox") {
    return null;
  }
  return folderIdAttr;
}

function renderInbox() {
  const list = document.getElementById("dashboard-inbox-list");
  const empty = document.getElementById("inbox-empty");
  const countEl = document.getElementById("inbox-count");
  const moreBtn = document.getElementById("inbox-show-more");
  if (!list) return;

  const allGroups = getInboxGroups();
  const q = normalizeText(state.inboxFilter);
  const filtered = q ? allGroups.filter((g) => groupMatchesQuery(g, q)) : allGroups;

  const limit = (state.inboxPage + 1) * INBOX_PAGE_SIZE;
  const visible = filtered.slice(0, limit);
  const remaining = filtered.length - limit;

  const frag = document.createDocumentFragment();
  visible.forEach((group) => frag.appendChild(buildGroupNode(group, { inInbox: true })));
  list.innerHTML = "";
  list.appendChild(frag);

  if (countEl) countEl.textContent = q ? `${filtered.length}/${allGroups.length}` : String(allGroups.length);
  if (empty) empty.classList.toggle("hidden", allGroups.length > 0);
  if (moreBtn) {
    if (remaining > 0) {
      moreBtn.textContent = `Show ${Math.min(INBOX_PAGE_SIZE, remaining)} more (${remaining} left)`;
      moreBtn.classList.remove("hidden");
    } else {
      moreBtn.classList.add("hidden");
    }
  }
}

function renderFoldersTree() {
  const root = document.getElementById("folders-tree-container");
  const empty = document.getElementById("tree-empty");
  const countEl = document.getElementById("tree-count");
  if (!root) return;

  const q = normalizeText(state.wsFilter || "");

  if (q) {
    // ── Search mode: flat list of all matching groups across folders + inbox ──
    const matches = state.savedGroups.filter(g => groupMatchesQuery(g, q));

    root.innerHTML = "";
    if (!matches.length) {
      if (empty) { empty.textContent = `No groups matching "${state.wsFilter}".`; empty.classList.remove("hidden"); }
    } else {
      if (empty) empty.classList.add("hidden");
      const frag = document.createDocumentFragment();
      matches.forEach(g => {
        const folder = g.folderId ? state.folders.find(f => f.id === g.folderId) : null;
        const wrap = document.createElement("div");
        wrap.className = "ws-search-result";
        const pathEl = document.createElement("div");
        pathEl.className = "ws-search-path";
        pathEl.textContent = folder ? `📁 ${folder.name}` : "📥 Inbox";
        wrap.appendChild(pathEl);
        wrap.appendChild(buildGroupNode(g, { inInbox: !g.folderId }));
        frag.appendChild(wrap);
      });
      root.appendChild(frag);
    }
    if (countEl) countEl.textContent = `${matches.length} found`;
    return;
  }

  // ── Normal tree mode ──────────────────────────────────────────────────────
  const rootFolders = getChildFolders(null);
  const frag = document.createDocumentFragment();
  rootFolders.forEach((folder) => frag.appendChild(buildFolderNode(folder)));
  root.innerHTML = "";
  root.appendChild(frag);

  const organizedCount = state.savedGroups.filter((g) => g.folderId).length;
  const total = state.folders.length + organizedCount;
  if (countEl) countEl.textContent = String(total);
  if (empty) { empty.textContent = "No folders yet. Click New Folder to start organizing."; empty.classList.toggle("hidden", rootFolders.length > 0); }
}

function renderTree() {
  if (!document.getElementById("folders-tree-container") && !document.getElementById("dashboard-inbox-list")) {
    return;
  }

  destroySortables();
  renderInbox();
  renderFoldersTree();
  initSortableEverywhere();
}

function buildFolderNode(folder) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-folder";
  wrapper.dataset.itemType = "folder";
  wrapper.dataset.folderId = folder.id;

  const expanded = folder.isExpanded !== false;
  const childFolders = getChildFolders(folder.id);
  const childGroups = getChildGroups(folder.id);
  const totalChildren = childFolders.length + childGroups.length;

  wrapper.innerHTML = `
    <div class="tree-folder-header">
      <button class="tree-chevron ${expanded ? "open" : ""}" type="button" title="Expand/Collapse" aria-label="Toggle folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      <svg class="tree-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="tree-folder-name" title="${escHtml(folder.name)}">${escHtml(folder.name)}</span>
      <span class="tree-folder-count">${totalChildren}</span>
      <div class="tree-folder-actions">
        <button class="action-add-subfolder" type="button" title="Add sub-folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        </button>
        <button class="action-rename" type="button" title="Rename">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="action-delete" type="button" title="Delete folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="tree-folder-body tree-list ${expanded ? "" : "collapsed"}" data-folder-id="${escHtml(folder.id)}"></div>
  `;

  const body = wrapper.querySelector(".tree-folder-body");
  // Use DocumentFragment for folder body too
  const bodyFrag = document.createDocumentFragment();
  childFolders.forEach((child) => bodyFrag.appendChild(buildFolderNode(child)));
  childGroups.forEach((group) => bodyFrag.appendChild(buildGroupNode(group)));
  body.appendChild(bodyFrag);

  const chevron = wrapper.querySelector(".tree-chevron");
  chevron.addEventListener("click", async (e) => {
    e.stopPropagation();
    const willCollapse = !body.classList.contains("collapsed");
    body.classList.toggle("collapsed", willCollapse);
    chevron.classList.toggle("open", !willCollapse);
    folder.isExpanded = !willCollapse;
    await sendMsg({
      action: "setFolderExpanded",
      folderId: folder.id,
      isExpanded: !willCollapse,
    });
  });

  wrapper.querySelector(".action-add-subfolder").addEventListener("click", (e) => {
    e.stopPropagation();
    openFolderModal({ parentId: folder.id });
  });

  wrapper.querySelector(".action-rename").addEventListener("click", (e) => {
    e.stopPropagation();
    startInlineRename(folder, wrapper);
  });

  wrapper.querySelector(".action-delete").addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await showModal({
      title: `Delete folder "${folder.name}"?`,
      body: "Groups inside will return to Inbox. Sub-folders move to root level.",
      confirmText: "Delete Folder", danger: true,
    });
    if (!ok) return;
    wrapper.remove();
    state.folders = state.folders.filter((f) => f.id !== folder.id);
    state.savedGroups.forEach((g) => {
      if (g.folderId === folder.id) g.folderId = null;
    });
    buildIndexes();
    showToast("Folder deleted", "success");
    sendMsg({ action: "deleteFolder", folderId: folder.id })
      .then(async (res) => {
        if (!res?.ok) {
          showToast("Could not delete folder", "error");
          await loadData();
          renderTree();
        }
      });
  });

  return wrapper;
}

// A second way to categorize (besides drag-and-drop): a compact dropdown that
// moves a group straight into any folder — or back to the Inbox — in one click.
function closeMoveMenu() {
  document.getElementById("move-menu")?.remove();
  document.removeEventListener("click", closeMoveMenu);
}

function openMoveMenu(group, anchorEl) {
  closeMoveMenu();
  const menu = document.createElement("div");
  menu.id = "move-menu";
  menu.className = "move-menu";

  const targets = [{ id: null, label: "📥 Inbox" }];
  getChildFolders(null).forEach((f) => addFolderOptions(f, 0, targets));

  targets.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isCurrent = (group.folderId ?? null) === t.id;
    btn.className = "move-menu-item" + (isCurrent ? " current" : "");
    btn.style.paddingLeft = `${12 + (t.depth || 0) * 14}px`;
    btn.textContent = t.label;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeMoveMenu();
      if (isCurrent) return;
      const g = state.groupIndex.get(group.uid);
      if (g) { g.folderId = t.id; buildIndexes(); }
      await sendMsg({ action: "moveItem", itemType: "group", itemId: group.uid, targetFolderId: t.id });
      await loadData();
      renderTree();
      showToast(t.id ? `Moved to ${state.folderIndex.get(t.id)?.name || "folder"}` : "Moved to Inbox", "success");
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  // Defer so this same click doesn't immediately close the menu.
  setTimeout(() => document.addEventListener("click", closeMoveMenu), 0);
}

// Flatten the folder tree into indented options for the move menu.
function addFolderOptions(folder, depth, out) {
  out.push({ id: folder.id, label: "📁 " + folder.name, depth: depth + 1 });
  getChildFolders(folder.id).forEach((child) => addFolderOptions(child, depth + 1, out));
}

function buildGroupNode(group, options = {}) {
  const inInbox = options.inInbox === true;
  const node = document.createElement("div");
  node.className = "tree-group";
  node.dataset.itemType = "group";
  node.dataset.groupUid = group.uid;

  const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
  const tabs = getGroupTabCount(group);
  const title = escHtml(group.title || "Unnamed Group");
  const statusClass = group.active ? "active" : "saved";
  const statusLabel = group.active ? "Active" : "Saved";
  const unst = group.tabsUnstored ? `<span class="unstored-badge">sync only</span>` : "";
  const removeBtn = inInbox
    ? ""
    : `<button class="action-remove" type="button" title="Remove from folder (send to Inbox)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>`;

  node.innerHTML = `
    <svg class="tree-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
    </svg>
    <span class="tree-group-dot" style="background:${dot}"></span>
    <span class="tree-group-title" title="${title}">${title}</span>
    <span class="tree-group-meta">${tabs} tab${tabs !== 1 ? "s" : ""}</span>
    ${unst}
    <span class="tree-group-status ${statusClass}">${statusLabel}</span>
    <div class="tree-group-actions">
      <button class="action-move" type="button" title="Move to folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      <button class="action-view" type="button" title="${group.active ? "Focus group" : "Restore group"}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      ${removeBtn}
    </div>
  `;

  node.querySelector(".action-move").addEventListener("click", (e) => {
    e.stopPropagation();
    openMoveMenu(group, e.currentTarget);
  });

  node.querySelector(".action-view").addEventListener("click", async (e) => {
    e.stopPropagation();
    await openOrFocusGroup(group);
  });

  const titleEl = node.querySelector(".tree-group-title");
  if (titleEl) {
    titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startInlineGroupRename(group, node, titleEl);
    });
  }

  const metaEl = node.querySelector(".tree-group-meta");
  if (metaEl) {
    metaEl.classList.add("tree-group-meta-expandable");
    metaEl.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleTreeGroupTabs(node, group);
    });
  }

  const removeEl = node.querySelector(".action-remove");
  if (removeEl) {
    removeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      node.remove();
      const g = state.groupIndex.get(group.uid);
      if (g) { g.folderId = null; buildIndexes(); }
      showToast("Moved to Inbox", "success");
      sendMsg({ action: "removeGroupFromFolder", groupUid: group.uid })
        .then(() => loadData().then(renderTree));
    });
  }

  return node;
}

const TAB_PREVIEW_LIMIT = 50;

function _makeTabListItem(t, itemClass) {
  const li = document.createElement("li");
  li.className = itemClass;
  const url = t.url || "";
  const title = t.title || url || "Untitled";
  const isLink = isSafeHref(url);
  if (isLink) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = url;
    a.className = "tree-tab-link";
    if (t.favIconUrl) {
      const img = document.createElement("img");
      img.src = t.favIconUrl;
      img.className = "tree-tab-favicon";
      img.alt = "";
      img.onerror = () => img.replaceWith(makeFaviconPlaceholder());
      a.appendChild(img);
    } else {
      a.appendChild(makeFaviconPlaceholder());
    }
    const span = document.createElement("span");
    span.className = "tree-tab-title";
    span.textContent = title;
    a.appendChild(span);
    try {
      const u = new URL(url);
      const path = (u.hostname + u.pathname + u.search).replace(/^www\./, "");
      const hint = path.length > 55 ? path.slice(0, 52) + "…" : path;
      if (hint && hint.toLowerCase() !== title.toLowerCase().slice(0, hint.length)) {
        const domSpan = document.createElement("span");
        domSpan.className = "cleanup-tab-domain";
        domSpan.textContent = hint;
        a.appendChild(domSpan);
      }
    } catch (_) {}
    li.appendChild(a);
  } else {
    li.textContent = title;
    li.style.color = "var(--text-muted)";
  }
  return li;
}

function _appendTabBatch(listEl, tabs, startIdx, itemClass) {
  const frag = document.createDocumentFragment();
  tabs.slice(startIdx).forEach((t) => frag.appendChild(_makeTabListItem(t, itemClass)));
  listEl.appendChild(frag);
}

function _addShowMoreBtn(listEl, tabs, shown, itemClass) {
  const remaining = tabs.length - shown;
  if (remaining <= 0) return;
  const li = document.createElement("li");
  li.className = "tab-show-more";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = `Show ${remaining} more tab${remaining !== 1 ? "s" : ""}…`;
  btn.addEventListener("click", () => {
    li.remove();
    _appendTabBatch(listEl, tabs, shown, itemClass);
  });
  li.appendChild(btn);
  listEl.appendChild(li);
}

function renderTreeTabsList(listEl, tabs) {
  listEl.innerHTML = "";
  if (!tabs.length) {
    listEl.innerHTML = '<li class="tree-group-tab-empty">No tabs stored — Restore to open in Chrome</li>';
    return;
  }
  const preview = tabs.slice(0, TAB_PREVIEW_LIMIT);
  const frag = document.createDocumentFragment();
  preview.forEach((t) => frag.appendChild(_makeTabListItem(t, "tree-group-tab-item")));
  listEl.appendChild(frag);
  _addShowMoreBtn(listEl, tabs, TAB_PREVIEW_LIMIT, "tree-group-tab-item");
}

function makeFaviconPlaceholder() {
  const sp = document.createElement("span");
  sp.className = "tree-tab-favicon-placeholder";
  return sp;
}

async function toggleTreeGroupTabs(node, group) {
  let list = node.querySelector(".tree-group-tabs-list");
  if (list && !list.classList.contains("hidden")) {
    list.classList.add("hidden");
    return;
  }
  if (!list) {
    list = document.createElement("ul");
    list.className = "tree-group-tabs-list";
    node.appendChild(list);
  }
  list.classList.remove("hidden");
  if (group.tabsLoaded && group.tabs?.length) {
    renderTreeTabsList(list, group.tabs);
    return;
  }
  list.innerHTML = "<li class=\"tree-group-tab-loading\">Loading…</li>";
  const res = await sendMsg({ action: "loadGroupTabs", groupUid: group.uid });
  if (!res?.ok) {
    list.innerHTML = "<li class=\"tree-group-tab-empty\">Could not load tabs</li>";
    return;
  }
  group.tabs = res.tabs || [];
  group.tabCount = group.tabs.length;
  group.tabsLoaded = true;
  const indexed = state.groupIndex.get(group.uid);
  if (indexed) {
    indexed.tabs = group.tabs;
    indexed.tabCount = group.tabCount;
    indexed.tabsLoaded = true;
  }
  if (!group.tabs.length) {
    list.innerHTML = '<li class="tree-group-tab-empty">Tab URLs not stored — re-capture from Chrome or import from backup file to recover</li>';
    return;
  }
  renderTreeTabsList(list, group.tabs);
}

async function openOrFocusGroup(group) {
  if (group.active && group.chromeGroupId != null) {
    try {
      const cg = await chrome.tabGroups.get(group.chromeGroupId);
      const tabs = await chrome.tabs.query({ groupId: group.chromeGroupId });
      if (tabs[0]) {
        await chrome.windows.update(cg.windowId, { focused: true });
        await chrome.tabs.update(tabs[0].id, { active: true });
      }
      showToast("Focused group in Chrome", "info");
    } catch (_) {
      showToast("Group not available", "error");
    }
    return;
  }
  const res = await sendMsg({ action: "restoreGroup", groupUid: group.uid });
  if (res?.ok) {
    showToast("Group restored", "success");
    await loadData();
    renderTree();
  } else if (res?.error) {
    showToast(res.error, "error");
  }
}

function startInlineRename(folder, wrapperEl) {
  const nameEl = wrapperEl.querySelector(".tree-folder-name");
  const current = folder.name;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-folder-rename";
  input.value = current;
  input.style.cssText =
    "flex:1;min-width:0;padding:3px 8px;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:5px;color:var(--text-primary);font-size:13px;font-weight:600;outline:none;";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (newName && newName !== current) {
      const res = await sendMsg({ action: "renameFolder", folderId: folder.id, name: newName });
      if (res?.ok) {
        showToast("Folder renamed", "success");
        await loadData();
        renderTree();
        return;
      }
    }
    renderTree();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      committed = true;
      renderTree();
    }
  });
  input.addEventListener("blur", commit);
}

function startInlineGroupRename(group, nodeEl, titleEl) {
  const current = group.title || "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-folder-rename";
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newTitle = input.value.trim();
    if (newTitle !== current) {
      await sendMsg({ action: "updateGroupTitle", groupUid: group.uid, title: newTitle });
      showToast("Group renamed", "success");
    }
    await loadData();
    renderTree();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { committed = true; renderTree(); }
  });
  input.addEventListener("blur", commit);
}

function renderCleanup() {
  renderCleanupUnnamed();
  renderCleanupDuplicates();
  renderCleanupDuplicateTabs();
}

// ── Tab-level dedup (mirrors background.js logic, client-side for counting) ──

const _TAB_TRACKING_PARAMS = [
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
  "fbclid","gclid","_ga","_gl","ref","source",
];

function _normTabUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    _TAB_TRACKING_PARAMS.forEach(p => u.searchParams.delete(p));
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, "");
    return u.toString();
  } catch (_) { return url.trim().toLowerCase(); }
}

function _normTabTitle(title) {
  if (!title) return "";
  return title.trim()
    .replace(/\s*[–\-]\s*\d+\s*$/, "")
    .replace(/\s*#\d+\s*$/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .toLowerCase();
}

function _countTabDuplicates(tabs) {
  const seenUrls = new Map();
  const seenTitleKeys = new Map();
  let count = 0;
  (tabs || []).forEach((t) => {
    if (!t.url) return;
    const normUrl = _normTabUrl(t.url);
    if (seenUrls.has(normUrl)) { count++; return; }
    seenUrls.set(normUrl, true);
    const normTitle = _normTabTitle(t.title || "");
    if (normTitle.length > 4) {
      try {
        const host = new URL(t.url).hostname.replace(/^www\./, "").toLowerCase();
        const key = `${host}::${normTitle}`;
        if (seenTitleKeys.has(key)) { count++; return; }
        seenTitleKeys.set(key, true);
      } catch (_) {}
    }
  });
  return count;
}

function renderCleanupDuplicateTabs() {
  const container = document.getElementById("cleanup-dup-tabs-list");
  const badge = document.getElementById("cleanup-dup-tabs-badge");
  if (!container) return;

  const filter = (state.cleanupFilter || "").toLowerCase();
  const groups = (state.groups || [])
    .map(g => ({ g, dups: _countTabDuplicates(g.tabs) }))
    .filter(({ g, dups }) => dups > 0 && (!filter || (g.title || "").toLowerCase().includes(filter)))
    .sort((a, b) => b.dups - a.dups);

  if (badge) badge.textContent = String(groups.length);

  if (!groups.length) {
    container.innerHTML = '<p class="cleanup-empty">No groups with duplicate tabs.</p>';
    return;
  }

  container.innerHTML = "";
  for (const { g, dups } of groups) {
    const dot = colorDot(g.color);
    const el = document.createElement("div");
    el.className = "cleanup-group-node";
    el.innerHTML = `
      <div class="cleanup-group-header">
        <span class="cleanup-dot" style="background:${dot}"></span>
        <span class="cleanup-title" title="${escHtml(g.title || "Unnamed")}">${escHtml(g.title || "Unnamed")}</span>
        <span class="cleanup-tabcount">${g.tabCount ?? (g.tabs?.length ?? 0)} tabs · <strong class="dup-tab-count">${dups} duplicate${dups !== 1 ? "s" : ""}</strong></span>
        <button class="cleanup-btn-dedup btn-secondary" type="button">Deduplicate</button>
      </div>`;
    el.querySelector(".cleanup-btn-dedup").addEventListener("click", async () => {
      const res = await sendMsg({ action: "deduplicateGroupTabs", groupUid: g.uid });
      if (res?.ok && res.removed > 0) {
        await loadData();
        renderCleanupDuplicateTabs();
        showToast(`Removed ${res.removed} duplicate tab${res.removed !== 1 ? "s" : ""} — ${res.kept} kept`, "success");
      } else {
        showToast("No duplicates found", "info");
      }
    });
    container.appendChild(el);
  }
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function toggleCleanupTabs(listEl, group) {
  if (!listEl.classList.contains("hidden")) {
    listEl.classList.add("hidden");
    return;
  }
  listEl.classList.remove("hidden");
  if (group.tabsLoaded && group.tabs?.length) {
    _renderCleanupTabsList(listEl, group.tabs);
    return;
  }
  listEl.innerHTML = '<li class="cleanup-tab-loading">Loading…</li>';
  const res = await sendMsg({ action: "loadGroupTabs", groupUid: group.uid });
  if (!res?.ok) {
    listEl.innerHTML = '<li class="cleanup-tab-empty">Could not load tabs</li>';
    return;
  }
  group.tabs = res.tabs || [];
  group.tabCount = group.tabs.length;
  group.tabsLoaded = true;
  const indexed = state.groupIndex.get(group.uid);
  if (indexed) { indexed.tabs = group.tabs; indexed.tabCount = group.tabCount; indexed.tabsLoaded = true; }
  _renderCleanupTabsList(listEl, group.tabs);
}

function _renderCleanupTabsList(listEl, tabs) {
  listEl.innerHTML = "";
  if (!tabs.length) {
    const li = document.createElement("li");
    li.className = "cleanup-tab-empty";
    li.textContent = "No tabs stored — re-import from Chrome to populate";
    listEl.appendChild(li);
    return;
  }
  const preview = tabs.slice(0, TAB_PREVIEW_LIMIT);
  const frag = document.createDocumentFragment();
  preview.forEach((t) => frag.appendChild(_makeTabListItem(t, "cleanup-tab-item")));
  listEl.appendChild(frag);
  _addShowMoreBtn(listEl, tabs, TAB_PREVIEW_LIMIT, "cleanup-tab-item");
}

function renderCleanupUnnamed() {
  const container = document.getElementById("cleanup-unnamed-list");
  const badge = document.getElementById("cleanup-unnamed-badge");
  if (!container) return;

  const q = normalizeText(state.cleanupFilter || "");
  const groups = state.savedGroups.filter((g) => {
    if (g.active) return false;
    const t = (g.title || "").trim();
    // A "ghost": claims to hold tabs but none are actually stored and there's no
    // way to recover them (not a cloud-restored group, which is labeled instead).
    // These were created by the old auto-capture bug — surface them so they can
    // be purged in one click.
    const isGhost = (g.tabs || []).length === 0 && !g.tabsUnstored;
    const isUnnamed = t.length <= 1 || (g.tabCount || 0) === 0 || isGhost;
    if (!isUnnamed) return false;
    return q ? normalizeText(t || "unnamed").includes(q) : true;
  });

  if (badge) badge.textContent = String(groups.length);

  if (!groups.length) {
    container.innerHTML = '<p class="cleanup-empty">No unnamed or empty groups.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  groups.forEach((group) => {
    const wrapper = document.createElement("div");
    wrapper.className = "cleanup-row-wrap";
    wrapper.dataset.uid = group.uid;

    const row = document.createElement("div");
    row.className = "cleanup-row";
    const dot = COLOR_HEX[group.color] || COLOR_HEX.grey;
    // Show the REAL stored tab count, not the cached tabCount — a ghost group
    // claims "3 tabs" but stores none, so this honestly reads "0 tabs".
    const tabs = (group.tabs || []).length || (group.tabsUnstored ? (group.tabCount || 0) : 0);
    const displayTitle = (group.title || "").trim() || "Unnamed";
    row.innerHTML = `
      <input type="checkbox" class="cleanup-check" />
      <span class="cleanup-dot" style="background:${dot}"></span>
      <span class="cleanup-title" title="${escHtml(displayTitle)}">${escHtml(displayTitle)}</span>
      <span class="cleanup-tabcount" title="Click to preview tabs">${tabs} tab${tabs !== 1 ? "s" : ""} <svg class="expand-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
      <button class="cleanup-btn-del" type="button" title="Delete this group">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    `;

    const tabList = document.createElement("ul");
    tabList.className = "cleanup-tabs-list hidden";

    row.querySelector(".cleanup-tabcount").addEventListener("click", (e) => {
      e.stopPropagation();
      const chevron = row.querySelector(".expand-chevron");
      chevron?.classList.toggle("open", tabList.classList.contains("hidden"));
      toggleCleanupTabs(tabList, group);
    });

    row.querySelector(".cleanup-btn-del").addEventListener("click", async () => {
      const name = group.title || "Unnamed Group";
      const count = group.tabCount || (group.tabs || []).length || 0;
      const ok = await showModal({
        title: `Delete "${name}"?`,
        body: `Permanently removes this group (${count} tab${count !== 1 ? "s" : ""}) from your workspace.`,
        confirmText: "Delete", danger: true,
      });
      if (!ok) return;
      const groupSnapshot = { ...group, tabs: [...(group.tabs || [])] };
      wrapper.remove();
      state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
      buildIndexes();
      await sendMsg({ action: "deleteGroup", groupUid: group.uid });
      showUndoToast(`"${name}" deleted`, () => {
        sendMsg({ action: "restoreDeletedGroup", group: groupSnapshot });
      });
    });

    wrapper.appendChild(row);
    wrapper.appendChild(tabList);
    frag.appendChild(wrapper);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

// Broad duplicate key: collapse separators and strip a trailing number/suffix
// so "koke" ≈ "koke11", "Kolento" ≈ "Kolento11", "Work 2" ≈ "Work". Falls back
// to the exact normalized title for all-numeric names so "1" and "2" don't merge.
function fuzzyDupKey(title) {
  const base = normalizeText(title || "");
  const stripped = base
    .replace(/[\s\-_.]+/g, "")   // drop spaces, -, _, .
    .replace(/\d+$/, "");        // drop a trailing number ("koke11" → "koke")
  return stripped || base;
}

function renderCleanupDuplicates() {
  const container = document.getElementById("cleanup-duplicates-list");
  const badge = document.getElementById("cleanup-duplicates-badge");
  if (!container) return;

  const byTitle = new Map();
  for (const g of state.savedGroups) {
    if (g.active) continue;
    const key = fuzzyDupKey(g.title || "");
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(g);
  }

  const q = normalizeText(state.cleanupFilter || "");
  const dupSets = [...byTitle.values()].filter((arr) => {
    if (arr.length <= 1) return false;
    return q ? normalizeText(arr[0].title || "").includes(q) : true;
  });
  if (badge) badge.textContent = String(dupSets.length);

  if (!dupSets.length) {
    container.innerHTML = '<p class="cleanup-empty">No duplicate groups.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  dupSets.forEach((groups) => {
    const sorted = [...groups].sort((a, b) => (b.tabCount || 0) - (a.tabCount || 0));
    const card = document.createElement("div");
    card.className = "cleanup-dup-card";
    const titleHtml = escHtml(sorted[0].title || "Unnamed");
    const totalTabs = groups.reduce((s, g) => s + (g.tabCount || 0), 0);

    card.innerHTML = `
      <div class="cleanup-dup-header">
        <strong class="cleanup-dup-name">${titleHtml}</strong>
        <span class="cleanup-dup-meta">${groups.length} groups · ${totalTabs} total tabs</span>
      </div>
      <div class="cleanup-dup-rows"></div>
      <div class="cleanup-dup-footer">
        <button class="cleanup-btn-merge wizard-btn wizard-btn-neon" type="button">
          Merge all → keep largest
        </button>
      </div>
    `;

    const rowsEl = card.querySelector(".cleanup-dup-rows");
    sorted.forEach((g, idx) => {
      const dot = COLOR_HEX[g.color] || COLOR_HEX.grey;
      const tabs = g.tabCount || 0;
      const where = g.folderId
        ? (state.folderIndex.get(g.folderId)?.name || "folder")
        : "Inbox";

      const rowWrap = document.createElement("div");
      rowWrap.className = "cleanup-dup-row-wrap";

      const row = document.createElement("div");
      row.className = "cleanup-dup-row";
      row.innerHTML = `
        <span class="cleanup-dot" style="background:${dot}"></span>
        <span class="cleanup-dup-row-info" title="Click to preview tabs">
          ${tabs} tab${tabs !== 1 ? "s" : ""} · ${escHtml(where)}
          <svg class="expand-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
        ${idx === 0
          ? `<span class="cleanup-keep-badge">Keep</span>`
          : `<button class="cleanup-btn-del-dup" type="button">Delete</button>`
        }
      `;

      const tabList = document.createElement("ul");
      tabList.className = "cleanup-tabs-list hidden";

      row.querySelector(".cleanup-dup-row-info").addEventListener("click", (e) => {
        e.stopPropagation();
        const chevron = row.querySelector(".expand-chevron");
        chevron?.classList.toggle("open", tabList.classList.contains("hidden"));
        toggleCleanupTabs(tabList, g);
      });

      if (idx > 0) {
        row.querySelector(".cleanup-btn-del-dup").addEventListener("click", async (e) => {
          e.stopPropagation();
          const name = g.title || "Unnamed Group";
          const count = g.tabCount || (g.tabs || []).length || 0;
          const okDup = await showModal({
            title: `Delete duplicate "${name}"?`,
            body: `Removes this copy (${count} tab${count !== 1 ? "s" : ""}). The original is kept.`,
            confirmText: "Delete", danger: true,
          });
          if (!okDup) return;
          const groupSnapshot = { ...g, tabs: [...(g.tabs || [])] };
          card.remove();
          await sendMsg({ action: "deleteGroup", groupUid: g.uid });
          await loadData();
          renderCleanupDuplicates();
          showUndoToast(`"${name}" deleted`, () => {
            sendMsg({ action: "restoreDeletedGroup", group: groupSnapshot });
          });
        });
      }

      rowWrap.appendChild(row);
      rowWrap.appendChild(tabList);
      rowsEl.appendChild(rowWrap);
    });

    card.querySelector(".cleanup-btn-merge").addEventListener("click", async () => {
      const keep = sorted[0];
      const keepName = keep.title || "Unnamed Group";
      const okMerge = await showModal({
        title: `Merge ${sorted.length} groups?`,
        body: `All tabs will be combined into "${keepName}". The other ${sorted.length - 1} group${sorted.length - 1 !== 1 ? "s" : ""} will be removed.`,
        confirmText: "Merge", icon: "🔀",
      });
      if (!okMerge) return;
      for (let i = 1; i < sorted.length; i++) {
        await sendMsg({ action: "mergeGroups", keepUid: keep.uid, mergeUid: sorted[i].uid });
      }
      await loadData();
      renderCleanup();
      showToast(`Merged ${sorted.length} → 1 group`, "success");
    });

    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function destroySortables() {
  sortableInstances.forEach((s) => {
    try {
      s.destroy();
    } catch (_) {}
  });
  sortableInstances.length = 0;
}

function initSortableEverywhere() {
  if (typeof Sortable === "undefined") return;

  document.querySelectorAll(".tree-list").forEach((listEl) => {
    const isInbox = listEl.dataset.folderId === "inbox";
    const instance = Sortable.create(listEl, {
      group: "shared",
      animation: 0,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      draggable: isInbox ? ".tree-group" : ".tree-folder, .tree-group",
      onStart: () => {
        document.querySelectorAll(".tree-list").forEach((el) => el.classList.add("drag-active"));
      },
      onEnd: async (evt) => {
        document.querySelectorAll(".tree-list").forEach((el) => el.classList.remove("drag-active"));

        const item = evt.item;
        const targetList = evt.to;
        if (!item || !targetList) {
          renderTree();
          return;
        }

        const folderIdAttr = targetList.dataset.folderId;
        const targetFolderId = resolveTargetFolderId(folderIdAttr);

        const itemType = item.dataset.itemType;
        const itemId = itemType === "folder" ? item.dataset.folderId : item.dataset.groupUid;
        if (!itemType || !itemId) {
          renderTree();
          return;
        }

        if (itemType === "folder" && targetFolderId === itemId) {
          renderTree();
          return;
        }

        // Optimistic state update — SortableJS already moved the DOM node, so we
        // leave it exactly where the user dropped it (no re-render → no scroll
        // jump, and the item doesn't snap back to an alphabetical slot).
        if (itemType === "group") {
          const g = state.groupIndex?.get(itemId);
          if (g) { g.folderId = targetFolderId; }
        } else if (itemType === "folder") {
          const f = state.folderIndex?.get(itemId);
          if (f) { f.parentId = targetFolderId; }
        }

        // Capture the new on-screen group order and make state match it, so the
        // drop STICKS across any later render instead of reverting.
        const domOrder = [...document.querySelectorAll(".tree-group[data-group-uid]")]
          .map((el) => el.dataset.groupUid);
        const seen = new Set(domOrder);
        const byUid = new Map(state.savedGroups.map((g) => [g.uid, g]));
        const reordered = domOrder.map((u) => byUid.get(u)).filter(Boolean);
        const rest = state.savedGroups.filter((g) => !seen.has(g.uid));
        state.savedGroups = [...reordered, ...rest];
        buildIndexes();

        // Ignore the storage echo from our own writes for a moment.
        _suppressTreeRenderUntil = Date.now() + 1500;

        const moveRes = await sendMsg({ action: "moveItem", itemType, itemId, targetFolderId });
        if (!moveRes?.ok) {
          _suppressTreeRenderUntil = 0;
          showToast("Move blocked (cycle or invalid)", "error");
          await loadData();
          renderTree();
          return;
        }
        // Persist the new manual order (folder membership already saved above).
        sendMsg({ action: "reorderGroups", orderedUids: state.savedGroups.map((g) => g.uid) });
      },
    });
    sortableInstances.push(instance);
  });
}

function openFolderModal(context) {
  modalContext = context || { parentId: null };
  const titleEl = document.getElementById("dash-modal-title");
  const input = document.getElementById("dash-folder-name");
  if (titleEl) {
    titleEl.textContent = modalContext.parentId ? "Create Sub-folder" : "Create Folder";
  }
  if (input) {
    input.value = "";
    document.getElementById("dash-modal-overlay")?.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
  }
}

function closeFolderModal() {
  modalContext = null;
  document.getElementById("dash-modal-overlay")?.classList.add("hidden");
}

async function confirmCreateFolder() {
  const input = document.getElementById("dash-folder-name");
  const name = input?.value.trim();
  if (!name) return;

  const parentId = modalContext?.parentId ?? null;
  const res = await sendMsg({ action: "createFolder", name, parentId });
  closeFolderModal();

  if (res?.ok) {
    showToast("Folder created", "success");
    await loadData();
    renderTree();
  } else {
    showToast("Could not create folder", "error");
  }
}

async function refreshWorkspace() {
  await loadData();
  // Always re-render the workspace tree directly — don't go through render()
  // which may bail out if state.activeView hasn't been set yet.
  renderTree();
  renderOverviewStats();
  showToast("Workspace refreshed", "success");
}

function openResetWorkspaceModal() {
  document.getElementById("reset-workspace-overlay")?.classList.remove("hidden");
}

function closeResetWorkspaceModal() {
  document.getElementById("reset-workspace-overlay")?.classList.add("hidden");
}

async function confirmResetWorkspace() {
  const g = state.savedGroups.length;
  const f = state.folders.length;
  const ok = await showModal({
    title: "Nuke everything?",
    body: `Permanently deletes all ${g} group${g !== 1 ? "s" : ""} and ${f} folder${f !== 1 ? "s" : ""}. Export a JSON backup first if you need to recover later.`,
    confirmText: "Yes, nuke it", cancelText: "Cancel", danger: true, icon: "💥",
  });
  if (!ok) return;
  closeResetWorkspaceModal();
  // True clean slate: also forget the deleted-group history so a fresh import
  // can bring everything back.
  await chrome.storage.local.remove(["savedGroups", "folders", "deletedGroupKeys"]);
  state.savedGroups = [];
  state.folders = [];
  buildIndexes();
  render();
  showToast("Workspace reset", "success");
}

// Offer (never force) a one-click recovery if a backup holds groups not in this
// profile. Restoring MERGES — it never overwrites or deletes existing groups.
async function checkRecoveryOffer() {
  if (document.getElementById("cloud-restore-banner")) return;
  const res = await sendMsg({ action: "getRecoveryStatus" });
  if (!res?.available) return;
  const banner = document.createElement("div");
  banner.id = "cloud-restore-banner";
  const count = res.groupCount || 0;
  const where = res.source === "file" ? "local backup" : "cloud backup";
  const tabsNote = res.hasTabs ? "with full tabs" : "titles only";
  banner.innerHTML = `
    <span class="cloud-banner-text">💾 ${count} group${count !== 1 ? "s" : ""} available in your ${where} (${tabsNote}). Restore them into this workspace?</span>
    <button class="cloud-banner-restore" type="button">Restore</button>
    <button class="cloud-banner-dismiss" type="button" title="Dismiss">✕</button>`;
  banner.querySelector(".cloud-banner-restore").addEventListener("click", async () => {
    banner.remove();
    const applyRes = await sendMsg({ action: "applyRecovery", source: res.source });
    if (applyRes?.ok) {
      await loadData();
      render();
      const n = applyRes.restored || 0;
      const tail = res.hasTabs ? "" : " — open each once to reload URLs";
      showToast(`Recovered ${n} group${n !== 1 ? "s" : ""}${tail}`, "success");
    } else {
      showToast("Recovery failed", "error");
    }
  });
  banner.querySelector(".cloud-banner-dismiss").addEventListener("click", () => banner.remove());
  // Insert at the top of the active view's content area
  const main = document.querySelector(".dashboard-main");
  main?.insertAdjacentElement("afterbegin", banner);
}

function bindListeners() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("btn-new-folder")?.addEventListener("click", () => {
    openFolderModal({ parentId: null });
  });

  document.getElementById("dash-modal-cancel")?.addEventListener("click", closeFolderModal);
  document.getElementById("dash-modal-confirm")?.addEventListener("click", confirmCreateFolder);
  document.getElementById("dash-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeFolderModal();
  });
  document.getElementById("dash-folder-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmCreateFolder();
    if (e.key === "Escape") closeFolderModal();
  });

  document.getElementById("toggle-lazy-restore")?.addEventListener("change", async (e) => {
    const lazyRestore = e.target.checked;
    await sendMsg({ action: "updateSettings", settings: { lazyRestore } });
    showToast(
      lazyRestore ? "Frozen-tab loading enabled" : "Tabs will now load immediately",
      "success"
    );
  });

  document.getElementById("toggle-free-mode")?.addEventListener("change", async (e) => {
    const freeMode = e.target.checked;
    await sendMsg({ action: "updateSettings", settings: { freeMode } });
    showToast(
      freeMode
        ? "Groups now open in their own window — nothing goes to Chrome's bookmarks bar"
        : "Groups will open as native Chrome tab groups",
      "success"
    );
  });

  // Dashboard import: list profiles, let the user pick, then import only those.
  document.getElementById("btn-quick-import")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-quick-import");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading profiles…"; }
    try {
      // 1. List available Chrome profiles
      const listRes = await sendMsg({ action: "listChromeProfiles" });
      if (!listRes?.ok || !listRes.profiles?.length) {
        showToast("❌ Could not list profiles: " + (listRes?.error || "native host error"), "error", 5000);
        return;
      }
      const profiles = listRes.profiles;
      // 2. Ask which profile(s) to import from
      const lines = profiles.map((p, i) =>
        `${i + 1}. ${p.displayName || p.profileName}${p.email ? " (" + p.email + ")" : ""}`
      ).join("\n");
      const input = await showModal({
        title: "Choose Profile",
        body: "Which profile to import from?\nEnter the number (or comma-separated numbers):\n\n" + lines,
        confirmText: "Import", cancelText: "Cancel", icon: "👤",
        inputConfig: { placeholder: "e.g. 1  or  1, 2", value: "1" },
      });
      if (input === null || !input.trim()) return;
      const indices = input.split(",")
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((i) => i >= 0 && i < profiles.length);
      if (!indices.length) { showToast("Invalid selection", "error"); return; }
      const dirs = indices.map((i) => profiles[i].dir).filter(Boolean);
      // Security: never fall back to "all profiles". If nothing resolved, abort.
      if (!dirs.length) { showToast("Invalid selection", "error"); return; }
      // 3. Import ONLY from the selected profiles
      if (btn) btn.textContent = "⏳ Importing…";
      const res = await sendMsg({ action: "importFromChrome", profileDirs: dirs });
      if (res?.ok) {
        await loadData();
        render();
        showToast(`✅ Imported ${res.added} new group${res.added !== 1 ? "s" : ""}${res.total ? " (" + res.total + " found)" : ""}`, "success", 5000);
      } else {
        showToast("❌ " + (res?.error || "Import failed"), "error", 5000);
      }
    } catch (e) {
      showToast("❌ " + (e?.message || "Import failed"), "error", 5000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "⬇ Select Profile & Import"; }
    }
  });

  document.getElementById("btn-import-fsa")?.addEventListener("click", () => {
    document.getElementById("fsa-dir-input")?.click();
  });
  document.getElementById("fsa-dir-input")?.addEventListener("change", (e) => {
    const files = e.target.files;
    e.target.value = ""; // allow re-selecting the same folder later
    importFromBrowserFolder(files);
  });

  // Copy-path buttons
  document.querySelectorAll(".path-copy-btn[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = document.getElementById(btn.dataset.copy);
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        const old = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = old; }, 1500);
      } catch (_) { showToast("Copy failed — select the path manually.", "error"); }
    });
  });

  // Drag-and-drop zone (bypasses Chrome's sensitive-directory block)
  const dz = document.getElementById("drop-zone");
  if (dz) {
    const over = (e) => { e.preventDefault(); dz.classList.add("drag-over"); };
    const leave = () => dz.classList.remove("drag-over");
    dz.addEventListener("dragenter", over);
    dz.addEventListener("dragover", over);
    dz.addEventListener("dragleave", leave);
    dz.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("drag-over");
      await importFromDataTransfer(e.dataTransfer);
    });
  }

  document.getElementById("btn-export-json")?.addEventListener("click", exportToJson);

  const importInput = document.getElementById("import-file-input");
  document.getElementById("btn-import-json")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", importFromJson);

  document.getElementById("inbox-search")?.addEventListener("input", (e) => {
    state.inboxFilter = e.target.value;
    state.inboxPage = 0;
    renderInbox();
  });

  document.getElementById("ws-search")?.addEventListener("input", (e) => {
    state.wsFilter = e.target.value;
    renderFoldersTree();
  });

  document.getElementById("inbox-show-more")?.addEventListener("click", () => {
    state.inboxPage++;
    renderInbox();
  });

  document.getElementById("cleanup-delete-selected")?.addEventListener("click", async () => {
    const checked = [...document.querySelectorAll(".cleanup-check:checked")];
    // data-uid lives on .cleanup-row-wrap, not on .cleanup-row
    const uids = checked.map((cb) => cb.closest(".cleanup-row-wrap")?.dataset.uid).filter(Boolean);
    if (!uids.length) { showToast("Select at least one group first", "info"); return; }
    const n = uids.length;
    const okBulk = await showModal({
      title: `Delete ${n} group${n !== 1 ? "s" : ""}?`,
      body: `This removes ${n === 1 ? "this group" : `all ${n} selected groups`} from your workspace. You can Undo within 8 seconds.`,
      confirmText: `Delete ${n}`, cancelText: "Cancel", danger: true, icon: "🗑️",
    });
    if (!okBulk) return;
    // Snapshot BEFORE deleting so Undo can restore everything in one shot.
    const snapshots = uids
      .map((u) => state.groupIndex.get(u))
      .filter(Boolean)
      .map((g) => ({ ...g, tabs: [...(g.tabs || [])] }));
    const res = await sendMsg({ action: "deleteMultipleGroups", groupUids: uids });
    if (res?.ok) {
      await loadData();
      renderCleanup();
      showUndoToast(`Deleted ${res.deleted} group${res.deleted !== 1 ? "s" : ""}`, () => {
        sendMsg({ action: "restoreDeletedGroups", groups: snapshots });
      });
    }
  });

  document.getElementById("cleanup-select-all")?.addEventListener("click", () => {
    document.querySelectorAll(".cleanup-check").forEach((cb) => { cb.checked = true; });
  });

  document.getElementById("cleanup-deselect-all")?.addEventListener("click", () => {
    document.querySelectorAll(".cleanup-check").forEach((cb) => { cb.checked = false; });
  });

  document.getElementById("cleanup-search")?.addEventListener("input", (e) => {
    state.cleanupFilter = e.target.value;
    renderCleanup();
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  document.getElementById("btn-test-native")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-test-native");
    const resultEl = document.getElementById("diag-result");
    if (!btn || !resultEl) return;
    btn.disabled = true;
    btn.textContent = "Testing…";
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = '<p class="diag-testing">Connecting to native host…</p>';
    try {
      const res = await sendMsg({ action: "listChromeProfiles" });
      if (res?.ok) {
        const profiles = res.profiles || [];
        resultEl.innerHTML = `
          <p class="diag-ok">✅ Connection successful</p>
          <p class="diag-detail">${profiles.length} Chrome profile(s) found:</p>
          <ul class="diag-list">
            ${profiles.map(p => `<li>${escHtml(p.displayName || p.profileName)}${p.email ? ` — <span class="diag-email">${escHtml(p.email)}</span>` : ""}</li>`).join("")}
          </ul>`;
      } else {
        resultEl.innerHTML = `
          <p class="diag-err">❌ Connection failed</p>
          <p class="diag-detail">${escHtml(res?.error || "Unknown error")}</p>
          <p class="diag-hint">Run the installer in the <code>NativeHost</code> folder (<code>install.bat</code> on Windows, <code>install.command</code> on macOS, <code>install.sh</code> on Linux), then fully close and reopen your browser.</p>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<p class="diag-err">❌ ${escHtml(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "📡 Test Connection";
    }
  });

  document.getElementById("btn-clear-import-history")?.addEventListener("click", async () => {
    const ok = await showModal({
      title: "Clear import history?",
      body: "Groups you previously deleted will be allowed to appear again the next time you import from Chrome. Your current groups are not affected.",
      confirmText: "Clear", cancelText: "Cancel", icon: "↺",
    });
    if (!ok) return;
    await sendMsg({ action: "clearImportHistory" });
    showToast("Import history cleared", "success");
  });

  document.getElementById("btn-refresh-workspace")?.addEventListener("click", refreshWorkspace);
  document.getElementById("btn-reset-workspace")?.addEventListener("click", openResetWorkspaceModal);
  document.getElementById("reset-workspace-cancel")?.addEventListener("click", closeResetWorkspaceModal);
  document.getElementById("reset-workspace-confirm")?.addEventListener("click", confirmResetWorkspace);
  document.getElementById("reset-workspace-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeResetWorkspaceModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("reset-workspace-overlay")?.classList.contains("hidden")) {
      closeResetWorkspaceModal();
    }
  });
}

async function exportToJson() {
  await loadData();
  if (!state.savedGroups.length && !state.folders.length) {
    showToast("Nothing to export — data may still be loading, try again", "info");
    return;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "TabGroup Master",
    version: "1.0.0",
    savedGroups: state.savedGroups,
    folders: state.folders,
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

async function importFromJson(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    showToast("Invalid JSON file", "error");
    return;
  }
  const res = await sendMsg({ action: "importJson", data });
  if (res?.ok) {
    await loadData();
    render();
    showToast(`Imported ${res.added} group${res.added !== 1 ? "s" : ""}`, "success");
  } else {
    showToast(res?.error || "Import failed", "error");
  }
}

const TOAST_MAX = 5;
function showToast(message, type = "info", durationMs = 3000) {
  const container = document.getElementById("toast-container");
  if (!container || !message) return;
  // FIFO: if at max capacity, drop the oldest toast
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
  setTimeout(dismiss, durationMs);
}

// ── Custom modal (replaces browser confirm / prompt) ─────────────────────────
function showModal({ title, body = "", confirmText = "Confirm", cancelText = "Cancel", danger = false, icon = null, inputConfig = null }) {
  return new Promise((resolve) => {
    const overlay   = document.getElementById("dash-confirm-overlay");
    const iconEl    = document.getElementById("dash-confirm-icon");
    const titleEl   = document.getElementById("dash-confirm-title");
    const bodyEl    = document.getElementById("dash-confirm-body");
    const inputWrap = document.getElementById("dash-confirm-input-wrap");
    const inputEl   = document.getElementById("dash-confirm-input");
    const okBtn     = document.getElementById("dash-confirm-ok");
    const cancelBtn = document.getElementById("dash-confirm-cancel");

    iconEl.textContent    = icon || (danger ? "🗑️" : inputConfig ? "💾" : "⚠️");
    titleEl.textContent = title;
    // Escape first: body strings interpolate group/profile names, which must
    // never be parsed as HTML (XSS in an extension page = full API access).
    bodyEl.innerHTML = escHtml(body).replace(/\n/g, "<br>");
    okBtn.textContent     = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = "dash-confirm-btn dash-confirm-ok" + (danger ? " dash-confirm-danger" : "");

    if (inputConfig) {
      inputWrap.classList.remove("hidden");
      inputEl.placeholder = inputConfig.placeholder || "";
      inputEl.value       = inputConfig.value || "";
      setTimeout(() => { inputEl.focus(); inputEl.select(); }, 60);
    } else {
      inputWrap.classList.add("hidden");
    }

    overlay.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("dash-confirm-visible")));

    let done = false;
    const close = (result) => {
      if (done) return; done = true;
      overlay.classList.remove("dash-confirm-visible");
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Only http(s)/ftp/mailto links are safe to render as clickable <a href>.
// Imported tab URLs are untrusted — a javascript: or data: href would run
// script in this extension page when clicked. Returns true if safe to link.
function isSafeHref(url) {
  return /^(https?|ftp|mailto):/i.test(String(url || "").trim());
}
