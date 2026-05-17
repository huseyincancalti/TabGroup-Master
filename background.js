// ─── TabGroup Master — Service Worker ───────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ─── Storage Helpers ─────────────────────────────────────────────────────────

async function getStore() {
  const data = await chrome.storage.local.get([
    "savedGroups", "folders", "categories", "conflicts", "importMode",
  ]);
  const savedGroups = (data.savedGroups || []).map(normalizeGroup);
  if (data.categories && data.categories.length) {
    await chrome.storage.local.remove("categories");
  }
  return {
    savedGroups,
    folders: data.folders || [],
    conflicts: data.conflicts || [],
    importMode: data.importMode || false,
  };
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeTitle(str) {
  return String(str || "")
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .trim()
    .toLowerCase();
}

function normalizeGroup(sg) {
  return {
    ...sg,
    folderId: sg.folderId ?? null,
  };
}

async function readLiveTabs(chromeGroupId) {
  const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
  return tabs.map((t) => ({
    id: t.id,
    url: t.url || "",
    title: t.title || "",
    favIconUrl: t.favIconUrl || "",
  }));
}

async function snapshotLiveGroups() {
  const chromeGroups = await chrome.tabGroups.query({});
  const snapshots = [];
  for (const g of chromeGroups) {
    const tabs = await readLiveTabs(g.id);
    snapshots.push({
      chromeGroupId: g.id,
      title: g.title || "",
      color: g.color || "grey",
      tabs,
    });
  }
  return snapshots;
}

// ─── Sync Logic ──────────────────────────────────────────────────────────────

let syncing = false;
let syncPending = false;

async function syncGroups() {
  if (syncing) {
    syncPending = true;
    return;
  }
  syncing = true;
  try {
    await syncGroupsInner();
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      syncGroups();
    }
  }
}

function findByTitle(savedGroups, title, { inactiveOnly = false } = {}) {
  const norm = normalizeTitle(title);
  if (!norm) return -1;
  return savedGroups.findIndex((sg) => {
    if (inactiveOnly && sg.active) return false;
    return normalizeTitle(sg.title) === norm;
  });
}

async function syncGroupsInner() {
  const store = await getStore();
  const liveGroupsSnapshot = await snapshotLiveGroups();
  const liveIds = new Set(liveGroupsSnapshot.map((g) => g.chromeGroupId));

  let { savedGroups, conflicts, importMode } = store;

  savedGroups = savedGroups.map((sg) => {
    if (sg.active && !liveIds.has(sg.chromeGroupId)) {
      return { ...sg, active: false, chromeGroupId: null };
    }
    return sg;
  });

  for (const liveGroup of liveGroupsSnapshot) {
    let existingIdx = savedGroups.findIndex(
      (sg) => sg.chromeGroupId === liveGroup.chromeGroupId
    );

    if (existingIdx === -1 && liveGroup.title) {
      existingIdx = findByTitle(savedGroups, liveGroup.title, { inactiveOnly: true });
      if (existingIdx === -1) {
        existingIdx = findByTitle(savedGroups, liveGroup.title);
      }
    }

    if (existingIdx !== -1) {
      const prev = savedGroups[existingIdx];
      savedGroups[existingIdx] = {
        ...prev,
        title: liveGroup.title,
        color: liveGroup.color,
        tabs: liveGroup.tabs,
        active: true,
        chromeGroupId: liveGroup.chromeGroupId,
        folderId: prev.folderId ?? null,
      };
    } else {
      if (importMode && liveGroup.title) {
        const matchIdx = savedGroups.findIndex(
          (sg) => normalizeTitle(sg.title) === normalizeTitle(liveGroup.title)
        );
        if (matchIdx !== -1) {
          const match = savedGroups[matchIdx];
          const alreadyConflict = conflicts.some(
            (c) => !c.resolved && c.savedGroupUid === match.uid &&
              c.incomingGroup?.chromeGroupId === liveGroup.chromeGroupId
          );
          if (!alreadyConflict) {
            conflicts.push({
              uid: uid(),
              savedGroupUid: match.uid,
              incomingGroup: { ...liveGroup },
              resolved: false,
            });
          }
          continue;
        }
      }

      savedGroups.push({
        uid: uid(),
        title: liveGroup.title,
        color: liveGroup.color,
        tabs: liveGroup.tabs,
        active: true,
        chromeGroupId: liveGroup.chromeGroupId,
        folderId: null,
      });
    }
  }

  await setStore({ savedGroups, conflicts });
  broadcast({ type: "STORE_UPDATED" });
}

// ─── Listeners ───────────────────────────────────────────────────────────────

chrome.tabGroups.onCreated.addListener(() => syncGroups());
chrome.tabGroups.onUpdated.addListener(() => syncGroups());
chrome.tabGroups.onRemoved.addListener(() => syncGroups());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.groupId !== undefined || info.title || info.url) syncGroups();
});
chrome.tabs.onRemoved.addListener(() => syncGroups());
chrome.tabs.onCreated.addListener(() => syncGroups());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg.action];
  if (h) {
    h(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

const handlers = {
  async getStore() { return getStore(); },

  async setImportMode({ value }) {
    await setStore({ importMode: value });
    if (value) await syncGroups();
    return { ok: true };
  },

  async runNativeMacro() {
    return new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(
        "com.tabgroup.master",
        { command: "START_MACRO" },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve({ ok: true, response });
          }
        }
      );
    });
  },

  async restoreGroup({ groupUid }) {
    const store = await getStore();
    const sg = store.savedGroups.find((g) => g.uid === groupUid);
    if (!sg || sg.active) return { ok: false };

    const window = await chrome.windows.getCurrent();
    const tabIds = [];
    for (const t of sg.tabs) {
      if (!t.url || t.url.startsWith("chrome://")) continue;
      const tab = await chrome.tabs.create({ url: t.url, windowId: window.id, active: false });
      tabIds.push(tab.id);
    }
    if (tabIds.length === 0) return { ok: false };

    const chromeGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: window.id } });
    await chrome.tabGroups.update(chromeGroupId, { title: sg.title, color: sg.color });

    const idx = store.savedGroups.findIndex((g) => g.uid === groupUid);
    store.savedGroups[idx].active = true;
    store.savedGroups[idx].chromeGroupId = chromeGroupId;
    await setStore({ savedGroups: store.savedGroups });
    await syncGroups();
    return { ok: true };
  },

  async deleteGroup({ groupUid }) {
    const store = await getStore();
    store.savedGroups = store.savedGroups.filter((g) => g.uid !== groupUid);
    store.conflicts = store.conflicts.filter((c) => c.savedGroupUid !== groupUid);
    await setStore({ savedGroups: store.savedGroups, conflicts: store.conflicts });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async removeGroupFromFolder({ groupUid }) {
    const store = await getStore();
    const sg = store.savedGroups.find((g) => g.uid === groupUid);
    if (!sg) return { ok: false };
    sg.folderId = null;
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async mergeConflict({ conflictUid }) {
    const store = await getStore();
    const conflict = store.conflicts.find((c) => c.uid === conflictUid);
    if (!conflict) return { ok: false };

    const savedIdx = store.savedGroups.findIndex((g) => g.uid === conflict.savedGroupUid);
    if (savedIdx === -1) return { ok: false };

    const existing = store.savedGroups[savedIdx];
    const incoming = conflict.incomingGroup;

    const seen = new Set(existing.tabs.map((t) => t.url));
    const merged = [...existing.tabs];
    for (const t of incoming.tabs) {
      if (t.url && !seen.has(t.url)) {
        seen.add(t.url);
        merged.push(t);
      }
    }

    store.savedGroups[savedIdx].tabs = merged;
    store.conflicts = store.conflicts.map((c) =>
      c.uid === conflictUid ? { ...c, resolved: true } : c
    );

    await setStore({ savedGroups: store.savedGroups, conflicts: store.conflicts });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async dismissConflict({ conflictUid }) {
    const store = await getStore();
    store.conflicts = store.conflicts.map((c) =>
      c.uid === conflictUid ? { ...c, resolved: true } : c
    );
    await setStore({ conflicts: store.conflicts });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async updateGroupTitle({ groupUid, title }) {
    const store = await getStore();
    const sg = store.savedGroups.find((g) => g.uid === groupUid);
    if (sg) {
      sg.title = title;
      if (sg.active && sg.chromeGroupId) {
        await chrome.tabGroups.update(sg.chromeGroupId, { title });
      }
      await setStore({ savedGroups: store.savedGroups });
    }
    return { ok: true };
  },

  async updateGroupColor({ groupUid, color }) {
    const store = await getStore();
    const sg = store.savedGroups.find((g) => g.uid === groupUid);
    if (sg) {
      sg.color = color;
      if (sg.active && sg.chromeGroupId) {
        await chrome.tabGroups.update(sg.chromeGroupId, { color });
      }
      await setStore({ savedGroups: store.savedGroups });
    }
    return { ok: true };
  },

  async createFolder({ name, parentId }) {
    const store = await getStore();
    const folder = {
      id: "f_" + uid(),
      name: (name || "New Folder").trim(),
      parentId: parentId || null,
      isExpanded: true,
    };
    store.folders.push(folder);
    await setStore({ folders: store.folders });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, folder };
  },

  async renameFolder({ folderId, name }) {
    const store = await getStore();
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return { ok: false };
    folder.name = (name || folder.name).trim();
    await setStore({ folders: store.folders });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async deleteFolder({ folderId }) {
    const store = await getStore();
    const target = store.folders.find((f) => f.id === folderId);
    if (!target) return { ok: false };

    store.savedGroups = store.savedGroups.map((g) =>
      g.folderId === folderId ? { ...g, folderId: null } : g
    );

    store.folders = store.folders
      .filter((f) => f.id !== folderId)
      .map((f) => (f.parentId === folderId ? { ...f, parentId: null } : f));

    await setStore({ folders: store.folders, savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async setFolderExpanded({ folderId, isExpanded }) {
    const store = await getStore();
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return { ok: false };
    folder.isExpanded = !!isExpanded;
    await setStore({ folders: store.folders });
    return { ok: true };
  },

  async moveItem({ itemType, itemId, targetFolderId }) {
    const store = await getStore();
    const newParent = targetFolderId || null;

    if (itemType === "folder") {
      const folder = store.folders.find((f) => f.id === itemId);
      if (!folder) return { ok: false };
      if (newParent === folder.id) return { ok: false };

      let ancestor = newParent;
      while (ancestor) {
        if (ancestor === folder.id) return { ok: false };
        const a = store.folders.find((f) => f.id === ancestor);
        ancestor = a ? a.parentId : null;
      }

      folder.parentId = newParent;
      await setStore({ folders: store.folders });
    } else if (itemType === "group") {
      const group = store.savedGroups.find((g) => g.uid === itemId);
      if (!group) return { ok: false };
      group.folderId = newParent;
      await setStore({ savedGroups: store.savedGroups });
    } else {
      return { ok: false };
    }

    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },
};

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

syncGroups();
