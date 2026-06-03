const STORE_KEYS = ["savedGroups", "folders"];
const RECONCILE_DEBOUNCE_MS = 150;
const NATIVE_HOST_NAME = "com.tabgroup.master";
const IMPORT_TIMEOUT_MS = 90_000;

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .trim()
    .toLowerCase();
}

function normalizeGroup(group) {
  const tabs = Array.isArray(group.tabs) ? group.tabs : [];
  return {
    uid: group.uid || uid(),
    title: group.title || "",
    color: group.color || "grey",
    tabs,
    tabCount: typeof group.tabCount === "number" ? group.tabCount : tabs.length,
    tabsLoaded: group.tabsLoaded ?? tabs.length > 0,
    active: group.active === true,
    chromeGroupId: group.chromeGroupId ?? null,
    folderId: group.folderId ?? null,
    savedAt: group.savedAt || Date.now(),
  };
}

function normalizeFolder(folder) {
  return {
    id: folder.id || "f_" + uid(),
    name: (folder.name || "New Folder").trim(),
    parentId: folder.parentId ?? null,
    isExpanded: folder.isExpanded !== false,
  };
}

async function getStore() {
  const data = await chrome.storage.local.get(STORE_KEYS);
  return {
    savedGroups: (data.savedGroups || []).map(normalizeGroup),
    folders: (data.folders || []).map(normalizeFolder),
  };
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
}

function buildIndexes(store) {
  return {
    groupsByUid: new Map(store.savedGroups.map((g) => [g.uid, g])),
    groupsByChromeId: new Map(
      store.savedGroups
        .filter((g) => g.chromeGroupId != null)
        .map((g) => [g.chromeGroupId, g])
    ),
    foldersById: new Map(store.folders.map((f) => [f.id, f])),
  };
}

async function readLiveTabs(chromeGroupId) {
  const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
  return tabs.map((t) => ({
    url: t.url || t.pendingUrl || "",
    title: t.title || "",
    favIconUrl: t.favIconUrl || "",
  }));
}

async function snapshotLiveGroups() {
  const groups = await chrome.tabGroups.query({});
  const snapshots = [];
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    snapshots.push({
      chromeGroupId: g.id,
      title: g.title || "",
      color: g.color || "grey",
      tabCount: tabs.length,
    });
  }
  return snapshots;
}

let reconciling = false;
let reconcilePending = false;
let reconcileTimer = null;

function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => reconcile(), RECONCILE_DEBOUNCE_MS);
}

async function reconcile() {
  if (reconciling) {
    reconcilePending = true;
    return;
  }
  reconciling = true;
  try {
    await reconcileInner();
  } finally {
    reconciling = false;
    if (reconcilePending) {
      reconcilePending = false;
      reconcile();
    }
  }
}

function makeCapturedGroup(snapshot, active) {
  return {
    uid: uid(),
    title: snapshot.title,
    color: snapshot.color,
    tabs: snapshot.tabs || [],
    tabCount: snapshot.tabCount,
    tabsLoaded: Array.isArray(snapshot.tabs),
    active,
    chromeGroupId: active ? snapshot.chromeGroupId ?? null : null,
    folderId: null,
    savedAt: Date.now(),
  };
}

async function reconcileInner() {
  const store = await getStore();
  const live = await snapshotLiveGroups();
  const liveIds = new Set(live.map((g) => g.chromeGroupId));
  const groups = store.savedGroups;

  for (const g of groups) {
    if (g.active && !liveIds.has(g.chromeGroupId)) {
      g.active = false;
      g.chromeGroupId = null;
    }
  }

  const byChromeId = new Map();
  const byTitle = new Map();
  for (const g of groups) {
    if (g.chromeGroupId != null) byChromeId.set(g.chromeGroupId, g);
    const key = normalizeTitle(g.title);
    if (key) {
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(g);
    }
  }

  const claimed = new Set();
  for (const lg of live) {
    let match = byChromeId.get(lg.chromeGroupId);
    if (!match) {
      const candidates = byTitle.get(normalizeTitle(lg.title)) || [];
      match =
        candidates.find((g) => !claimed.has(g.uid) && !g.active) ||
        candidates.find((g) => !claimed.has(g.uid));
    }
    if (match) {
      claimed.add(match.uid);
      match.title = lg.title;
      match.color = lg.color;
      match.active = true;
      match.chromeGroupId = lg.chromeGroupId;
      match.tabCount = lg.tabCount;
    } else {
      groups.push(makeCapturedGroup({ ...lg, tabs: undefined }, true));
    }
  }

  await setStore({ savedGroups: groups });
  broadcast({ type: "STORE_UPDATED" });
}

function importFromChrome() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ ok: false, error: "Native host not found. Run NativeHost/install.bat, then restart Chrome." });
      return;
    }
    if (!port) {
      resolve({ ok: false, error: "Native host not found. Run NativeHost/install.bat, then restart Chrome." });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch (_) {}
      resolve(result);
    };

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      finish({ ok: false, error: err || "Native host disconnected. Run install.bat and restart Chrome." });
    });

    port.onMessage.addListener(async (msg) => {
      if (msg?.action !== "extractResult") return;
      if (!msg.ok) {
        finish({ ok: false, error: msg.error || "Extraction failed" });
        return;
      }
      const res = await importStore(msg.data);
      finish({ ok: true, added: res.added, total: (msg.data?.savedGroups || []).length });
    });

    const timer = setTimeout(
      () => finish({ ok: false, error: "Timed out waiting for native host" }),
      IMPORT_TIMEOUT_MS
    );
    port.postMessage({ action: "extract" });
  });
}

async function importStore(data) {
  if (!data || typeof data !== "object") return { added: 0 };
  const store = await getStore();
  const incomingFolders = Array.isArray(data.folders) ? data.folders : [];
  const incomingGroups = Array.isArray(data.savedGroups) ? data.savedGroups : [];

  const folderIds = new Set(store.folders.map((f) => f.id));
  for (const folder of incomingFolders) {
    if (folder?.id && !folderIds.has(folder.id)) {
      store.folders.push(normalizeFolder(folder));
      folderIds.add(folder.id);
    }
  }

  const dedupKey = (g) => normalizeTitle(g?.title) || (g?.tabs?.[0]?.url || "");
  const seen = new Set(store.savedGroups.map(dedupKey));
  let added = 0;
  for (const group of incomingGroups) {
    const key = dedupKey(group);
    if (key && seen.has(key)) continue;
    store.savedGroups.push(normalizeGroup({ ...group, uid: uid(), active: false, chromeGroupId: null }));
    if (key) seen.add(key);
    added++;
  }

  await setStore({ savedGroups: store.savedGroups, folders: store.folders });
  broadcast({ type: "STORE_UPDATED" });
  return { added };
}

chrome.tabGroups.onCreated.addListener(scheduleReconcile);
chrome.tabGroups.onUpdated.addListener(scheduleReconcile);
chrome.tabGroups.onRemoved.addListener(scheduleReconcile);
chrome.tabs.onRemoved.addListener(scheduleReconcile);
chrome.tabs.onCreated.addListener(scheduleReconcile);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.groupId !== undefined || info.title || info.url) scheduleReconcile();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.action];
  if (!handler) return;
  handler(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
  return true;
});

const handlers = {
  async getStore() {
    return getStore();
  },

  async importFromChrome() {
    return importFromChrome();
  },

  async loadGroupTabs({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    if (group.active && group.chromeGroupId != null) {
      const tabs = await readLiveTabs(group.chromeGroupId);
      group.tabs = tabs;
      group.tabCount = tabs.length;
      group.tabsLoaded = true;
      await setStore({ savedGroups: store.savedGroups });
      return { ok: true, tabs };
    }
    return { ok: true, tabs: group.tabs || [] };
  },

  async restoreGroup({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group || group.active) return { ok: false };
    if (!group.tabs?.length) return { ok: false, error: "No tabs stored for this group" };

    const window = await chrome.windows.getCurrent();
    const tabIds = [];
    for (const tab of group.tabs) {
      if (!tab.url || tab.url.startsWith("chrome://")) continue;
      const created = await chrome.tabs.create({ url: tab.url, windowId: window.id, active: false });
      tabIds.push(created.id);
    }
    if (tabIds.length === 0) return { ok: false, error: "No restorable tabs" };

    const chromeGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: window.id } });
    await chrome.tabGroups.update(chromeGroupId, { title: group.title, color: group.color });

    group.active = true;
    group.chromeGroupId = chromeGroupId;
    await setStore({ savedGroups: store.savedGroups });
    await reconcile();
    return { ok: true };
  },

  async deleteGroup({ groupUid }) {
    const store = await getStore();
    const savedGroups = store.savedGroups.filter((g) => g.uid !== groupUid);
    await setStore({ savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async updateGroupTitle({ groupUid, title }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    group.title = title;
    if (group.active && group.chromeGroupId != null) {
      await chrome.tabGroups.update(group.chromeGroupId, { title }).catch(() => {});
    }
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async updateGroupColor({ groupUid, color }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    group.color = color;
    if (group.active && group.chromeGroupId != null) {
      await chrome.tabGroups.update(group.chromeGroupId, { color }).catch(() => {});
    }
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async createFolder({ name, parentId }) {
    const store = await getStore();
    const folder = normalizeFolder({ name, parentId: parentId || null });
    store.folders.push(folder);
    await setStore({ folders: store.folders });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, folder };
  },

  async renameFolder({ folderId, name }) {
    const store = await getStore();
    const folder = buildIndexes(store).foldersById.get(folderId);
    if (!folder) return { ok: false };
    folder.name = (name || folder.name).trim();
    await setStore({ folders: store.folders });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async deleteFolder({ folderId }) {
    const store = await getStore();
    if (!buildIndexes(store).foldersById.get(folderId)) return { ok: false };
    const savedGroups = store.savedGroups.map((g) =>
      g.folderId === folderId ? { ...g, folderId: null } : g
    );
    const folders = store.folders
      .filter((f) => f.id !== folderId)
      .map((f) => (f.parentId === folderId ? { ...f, parentId: null } : f));
    await setStore({ folders, savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async setFolderExpanded({ folderId, isExpanded }) {
    const store = await getStore();
    const folder = buildIndexes(store).foldersById.get(folderId);
    if (!folder) return { ok: false };
    folder.isExpanded = !!isExpanded;
    await setStore({ folders: store.folders });
    return { ok: true };
  },

  async moveItem({ itemType, itemId, targetFolderId }) {
    const store = await getStore();
    const indexes = buildIndexes(store);
    const newParent = targetFolderId || null;

    if (itemType === "folder") {
      const folder = indexes.foldersById.get(itemId);
      if (!folder || newParent === folder.id) return { ok: false };
      let ancestor = newParent;
      while (ancestor) {
        if (ancestor === folder.id) return { ok: false };
        ancestor = indexes.foldersById.get(ancestor)?.parentId ?? null;
      }
      folder.parentId = newParent;
      await setStore({ folders: store.folders });
    } else if (itemType === "group") {
      const group = indexes.groupsByUid.get(itemId);
      if (!group) return { ok: false };
      group.folderId = newParent;
      await setStore({ savedGroups: store.savedGroups });
    } else {
      return { ok: false };
    }

    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async removeGroupFromFolder({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    group.folderId = null;
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async mergeGroups({ keepUid, mergeUid }) {
    const store = await getStore();
    const idx = buildIndexes(store);
    const keep = idx.groupsByUid.get(keepUid);
    const merge = idx.groupsByUid.get(mergeUid);
    if (!keep || !merge) return { ok: false };
    const seen = new Set((keep.tabs || []).map((t) => t.url).filter(Boolean));
    for (const tab of (merge.tabs || [])) {
      if (tab.url && !seen.has(tab.url)) {
        keep.tabs.push(tab);
        seen.add(tab.url);
      }
    }
    keep.tabCount = keep.tabs.length;
    keep.tabsLoaded = true;
    store.savedGroups = store.savedGroups.filter((g) => g.uid !== mergeUid);
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async deleteMultipleGroups({ groupUids }) {
    if (!Array.isArray(groupUids) || !groupUids.length) return { ok: false };
    const toDelete = new Set(groupUids);
    const store = await getStore();
    const savedGroups = store.savedGroups.filter((g) => !toDelete.has(g.uid));
    await setStore({ savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, deleted: groupUids.length };
  },

  async importJson({ data }) {
    if (!data || typeof data !== "object") return { ok: false, error: "Invalid backup file" };
    const res = await importStore(data);
    return { ok: true, added: res.added };
  },
};

reconcile();
