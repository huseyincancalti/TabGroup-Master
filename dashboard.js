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
});

async function loadSettings() {
  const res = await sendMsg({ action: "getSettings" });
  const s = res?.settings || {};
  const lazyEl = document.getElementById("toggle-lazy-restore");
  const freeEl = document.getElementById("toggle-free-mode");
  if (lazyEl) lazyEl.checked = s.lazyRestore !== false;
  if (freeEl) freeEl.checked = s.freeMode !== false;
}

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
    showToast(`♻️ Restored ${message.groupCount} groups + ${message.folderCount} folders from sync backup`, "info");
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
  let store = await sendMsg({ action: "getStore" });

  if (!store) {
    // Service worker unresponsive — read directly from chrome.storage.local as fallback
    try {
      const raw = await chrome.storage.local.get(["savedGroups", "folders"]);
      store = { savedGroups: raw.savedGroups || [], folders: raw.folders || [] };
    } catch (_) { return; }
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

function getChildGroups(folderId) {
  return (state.childGroupsByFolder.get(folderId) || [])
    .slice()
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (a.title || "").localeCompare(b.title || "");
    });
}

function getInboxGroups() {
  return (state.inboxGroups || [])
    .slice()
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
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
  const filtered = q
    ? allGroups.filter((g) => normalizeText(g.title || "unnamed group").includes(q))
    : allGroups;

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

  const rootFolders = getChildFolders(null);

  // Build off-DOM via DocumentFragment — single reflow
  const frag = document.createDocumentFragment();
  rootFolders.forEach((folder) => frag.appendChild(buildFolderNode(folder)));
  root.innerHTML = "";
  root.appendChild(frag);

  const organizedCount = state.savedGroups.filter((g) => g.folderId).length;
  const total = state.folders.length + organizedCount;
  if (countEl) countEl.textContent = String(total);
  if (empty) empty.classList.toggle("hidden", rootFolders.length > 0);
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
    if (!confirm(`Delete folder "${folder.name}"? Groups return to Inbox; sub-folders move to root.`)) return;
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
    <span class="tree-group-status ${statusClass}">${statusLabel}</span>
    <div class="tree-group-actions">
      <button class="action-view" type="button" title="${group.active ? "Focus group" : "Restore group"}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      ${removeBtn}
    </div>
  `;

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

function renderTreeTabsList(listEl, tabs) {
  listEl.innerHTML = "";
  if (!tabs.length) {
    listEl.innerHTML = '<li class="tree-group-tab-empty">No tabs stored — Restore to open in Chrome</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  tabs.forEach((t) => {
    const li = document.createElement("li");
    li.className = "tree-group-tab-item";
    const url = t.url || "";
    const title = t.title || url || "Untitled";
    const isLink = url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
    if (isLink) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = url;
      a.className = "tree-tab-link";
      // Favicon
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
      // URL path hint — shows "youtube.com/watch?v=…" so generic titles are actionable
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
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
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
  const frag = document.createDocumentFragment();
  tabs.forEach((t) => {
    const li = document.createElement("li");
    li.className = "cleanup-tab-item";
    const url = t.url || "";
    const title = t.title || url || "Untitled";
    const isLink = url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");

    if (isLink) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = url;              // full URL shown on hover
      a.className = "tree-tab-link";  // reuse workspace styles

      // Favicon
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

      // Title
      const titleSpan = document.createElement("span");
      titleSpan.className = "tree-tab-title";
      titleSpan.textContent = title;
      a.appendChild(titleSpan);

      // URL path hint — e.g. "youtube.com/watch?v=abc123" tells you WHICH YouTube page
      try {
        const u = new URL(url);
        const path = (u.hostname + u.pathname + u.search).replace(/^www\./, "");
        const hint = path.length > 64 ? path.slice(0, 61) + "…" : path;
        if (hint && hint.toLowerCase() !== title.toLowerCase().slice(0, hint.length)) {
          const domSpan = document.createElement("span");
          domSpan.className = "cleanup-tab-domain";
          domSpan.textContent = hint;
          a.appendChild(domSpan);
        }
      } catch (_) { /* ignore bad URLs */ }

      li.appendChild(a);
    } else {
      // Non-navigable (chrome:// etc.) — plain text
      li.textContent = title;
      li.style.color = "var(--text-muted)";
    }
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
}

function renderCleanupUnnamed() {
  const container = document.getElementById("cleanup-unnamed-list");
  const badge = document.getElementById("cleanup-unnamed-badge");
  if (!container) return;

  const q = normalizeText(state.cleanupFilter || "");
  const groups = state.savedGroups.filter((g) => {
    if (g.active) return false;
    const t = (g.title || "").trim();
    const isUnnamed = t.length <= 1 || (g.tabCount || 0) === 0;
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
    const tabs = group.tabCount || 0;
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
      wrapper.remove();
      state.savedGroups = state.savedGroups.filter((g) => g.uid !== group.uid);
      buildIndexes();
      showToast("Deleted", "success");
      await sendMsg({ action: "deleteGroup", groupUid: group.uid });
    });

    wrapper.appendChild(row);
    wrapper.appendChild(tabList);
    frag.appendChild(wrapper);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function renderCleanupDuplicates() {
  const container = document.getElementById("cleanup-duplicates-list");
  const badge = document.getElementById("cleanup-duplicates-badge");
  if (!container) return;

  const byTitle = new Map();
  for (const g of state.savedGroups) {
    if (g.active) continue;
    const key = normalizeText(g.title || "");
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
          card.remove();
          await sendMsg({ action: "deleteGroup", groupUid: g.uid });
          await loadData();
          renderCleanupDuplicates();
          showToast("Deleted", "success");
        });
      }

      rowWrap.appendChild(row);
      rowWrap.appendChild(tabList);
      rowsEl.appendChild(rowWrap);
    });

    card.querySelector(".cleanup-btn-merge").addEventListener("click", async () => {
      const keep = sorted[0];
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

        // Optimistic state update — SortableJS already moved the DOM node
        if (itemType === "group") {
          const g = state.groupIndex?.get(itemId);
          if (g) { g.folderId = targetFolderId; buildIndexes(); }
        } else if (itemType === "folder") {
          const f = state.folderIndex?.get(itemId);
          if (f) { f.parentId = targetFolderId; buildIndexes(); }
        }

        // Fire to background asynchronously — no UI block
        sendMsg({ action: "moveItem", itemType, itemId, targetFolderId })
          .then(async (res) => {
            if (!res?.ok) {
              showToast("Move blocked (cycle or invalid)", "error");
              await loadData();
              renderTree();
            }
            // On success, storage.onChanged triggers a background reconcile
          });
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
  closeResetWorkspaceModal();
  await chrome.storage.local.remove(["savedGroups", "folders"]);
  state.savedGroups = [];
  state.folders = [];
  buildIndexes();
  render();
  showToast("Workspace reset", "success");
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

  document.getElementById("btn-export-json")?.addEventListener("click", exportToJson);

  const importInput = document.getElementById("import-file-input");
  document.getElementById("btn-import-json")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", importFromJson);

  document.getElementById("inbox-search")?.addEventListener("input", (e) => {
    state.inboxFilter = e.target.value;
    state.inboxPage = 0;
    renderInbox();
  });

  document.getElementById("inbox-show-more")?.addEventListener("click", () => {
    state.inboxPage++;
    renderInbox();
  });

  document.getElementById("cleanup-delete-selected")?.addEventListener("click", async () => {
    const checked = [...document.querySelectorAll(".cleanup-check:checked")];
    const uids = checked.map((cb) => cb.closest(".cleanup-row")?.dataset.uid).filter(Boolean);
    if (!uids.length) { showToast("Select groups first", "info"); return; }
    const res = await sendMsg({ action: "deleteMultipleGroups", groupUids: uids });
    if (res?.ok) {
      showToast(`Deleted ${res.deleted} group${res.deleted !== 1 ? "s" : ""}`, "success");
      await loadData();
      renderCleanup();
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
          <p class="diag-hint">Run <code>NativeHost\\install.bat</code>, then fully close Chrome (all windows + Task Manager → kill chrome.exe), and reopen.</p>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<p class="diag-err">❌ ${escHtml(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Test Connection";
    }
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
    version: "2.0.0",
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
