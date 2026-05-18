// ─── TabGroup Master — Dashboard ───

const COLOR_HEX = {
  grey: "#5f6368", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663",
  green: "#81c995", pink: "#f48fb1", purple: "#d7aefb", cyan: "#78d9ec", orange: "#fcad70",
};

let state = {
  savedGroups: [],
  folders: [],
  activeView: "overview",
  // Normalized O(1) indexes rebuilt after every loadData() / state mutation
  groupIndex: new Map(),          // uid -> group
  folderIndex: new Map(),         // id  -> folder
  childFoldersByParent: new Map(),// parentKey -> folder[]
  childGroupsByFolder: new Map(), // folderId  -> group[]
  inboxGroups: [],
};

let modalContext = null;
const sortableInstances = [];

document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  bindListeners();
  MacroWizard.init({
    showToast,
    onImportModeEnabled: async () => {
      await loadData();
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
  }
}

function render() {
  if (state.activeView === "workspace" || document.getElementById("view-workspace")?.classList.contains("active")) {
    renderTree();
  }
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
  if (!list) return;

  const groups = getInboxGroups();
  // Build off-DOM via DocumentFragment — single reflow
  const frag = document.createDocumentFragment();
  groups.forEach((group) => frag.appendChild(buildGroupNode(group, { inInbox: true })));
  list.innerHTML = "";
  list.appendChild(frag);

  if (countEl) countEl.textContent = String(groups.length);
  if (empty) empty.classList.toggle("hidden", groups.length > 0);
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
    const res = await sendMsg({ action: "deleteFolder", folderId: folder.id });
    if (res?.ok) {
      showToast("Folder deleted", "success");
      await loadData();
      renderTree();
    }
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
  const tabs = (group.tabs || []).length;
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

  const removeEl = node.querySelector(".action-remove");
  if (removeEl) {
    removeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      // Optimistic: remove node from DOM and update indexes instantly
      node.remove();
      const g = state.groupIndex.get(group.uid);
      if (g) {
        g.folderId = null;
        buildIndexes();
      }
      showToast("Moved to Inbox", "success");
      // Async persistence — does not block UI
      sendMsg({ action: "removeGroupFromFolder", groupUid: group.uid })
        .then(() => loadData().then(renderTree));
    });
  }

  return node;
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
      animation: 150,
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

  document.getElementById("btn-export-json")?.addEventListener("click", exportToJson);
}

async function exportToJson() {
  await loadData();
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
