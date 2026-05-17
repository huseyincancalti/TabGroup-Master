// ─── TabGroup Master — Service Worker ───────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

let nativePort = null; // Python iletişim tüneli

// ─── Storage Helpers ─────────────────────────────────────────────────────────

async function getStore() {
  const data = await chrome.storage.local.get([
    "savedGroups", "categories", "conflicts", "importMode",
  ]);
  return {
    savedGroups: data.savedGroups || [],   
    categories:  data.categories  || [],   
    conflicts:   data.conflicts   || [],   
    importMode:  data.importMode  || false,
  };
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Read live tabs for a Chrome group ───────────────────────────────────────

async function readLiveTabs(chromeGroupId) {
  const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
  return tabs.map((t) => ({
    id:         t.id,         // Silebilmek için ID eklendi
    url:        t.url || "",
    title:      t.title || "",
    favIconUrl: t.favIconUrl || "",
  }));
}

// ─── Snapshot all currently open Chrome groups ───────────────────────────────

async function snapshotLiveGroups() {
  const chromeGroups = await chrome.tabGroups.query({});
  const snapshots = [];
  for (const g of chromeGroups) {
    const tabs = await readLiveTabs(g.id);
    snapshots.push({
      chromeGroupId: g.id,
      title:  g.title  || "",
      color:  g.color  || "grey",
      tabs,
    });
  }
  return snapshots;
}

// ─── Sync Logic with Concurrency Lock ────────────────────────────────────────
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

    // --- OTOMATİK BAŞA SARMA YAKALAYICI (Wrap-Around Detection) ---
    const isBlankWrapAround = liveGroup.title === "" && 
                              liveGroup.tabs.length === 1 && 
                              (liveGroup.tabs[0].url.startsWith("chrome://newtab") || liveGroup.tabs[0].url === "");

    if (importMode && isBlankWrapAround) {
      // 1. Python Makrosunu Anında Durdur!
      if (nativePort) {
        nativePort.postMessage({ command: "STOP_MACRO" });
      }
      // 2. Yanlışlıkla açılan bu boş grubu ve sekmeyi anında yok et
      const tabIds = liveGroup.tabs.map(t => t.id);
      chrome.tabs.remove(tabIds).catch(()=>{});

      continue; // Bu hatayı veritabanına kaydetme
    }
    // ---------------------------------------------------------------

    const existingIdx = savedGroups.findIndex(
      (sg) => sg.chromeGroupId === liveGroup.chromeGroupId
    );

    if (existingIdx !== -1) {
      savedGroups[existingIdx] = {
        ...savedGroups[existingIdx],
        title:  liveGroup.title,
        color:  liveGroup.color,
        tabs:   liveGroup.tabs,
        active: true,
        chromeGroupId: liveGroup.chromeGroupId,
      };
    } else {
      if (importMode && liveGroup.title) {
        const match = savedGroups.find(
          (sg) => sg.title.trim().toLowerCase() === liveGroup.title.trim().toLowerCase()
        );
        if (match) {
          const alreadyConflict = conflicts.some(
            (c) => !c.resolved && c.savedGroupUid === match.uid &&
                   c.incomingGroup.chromeGroupId === liveGroup.chromeGroupId
          );
          if (!alreadyConflict) {
            conflicts.push({
              uid: uid(),
              savedGroupUid: match.uid,
              incomingGroup: { ...liveGroup },
              resolved: false,
            });
          }
          
          try {
            const groupTabs = await chrome.tabs.query({ groupId: liveGroup.chromeGroupId });
            for (const t of groupTabs) {
              if (!t.active) chrome.tabs.discard(t.id).catch(()=>{});
            }
          } catch(e) {}
          
          continue; 
        }
      }
      
      savedGroups.push({
        uid:  uid(),
        title: liveGroup.title,
        color: liveGroup.color,
        tabs:  liveGroup.tabs,
        active: true,
        chromeGroupId: liveGroup.chromeGroupId,
      });

      if (importMode) {
        try {
          const groupTabs = await chrome.tabs.query({ groupId: liveGroup.chromeGroupId });
          for (const t of groupTabs) {
            if (!t.active) chrome.tabs.discard(t.id).catch(()=>{});
          }
        } catch(e) {}
      }
    }
  }

  await setStore({ savedGroups, conflicts });
  broadcast({ type: "STORE_UPDATED" });
}

// ─── Chrome event listeners ───────────────────────────────────────────────────

chrome.tabGroups.onCreated.addListener(() => syncGroups());
chrome.tabGroups.onUpdated.addListener(() => syncGroups());
chrome.tabGroups.onRemoved.addListener(() => syncGroups());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.groupId !== undefined || info.title || info.url) syncGroups();
});
chrome.tabs.onRemoved.addListener(() => syncGroups());
chrome.tabs.onCreated.addListener(() => syncGroups());

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg.action];
  if (h) { h(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
});

const handlers = {
  async getStore() { return getStore(); },
  async setImportMode({ value }) {
    await setStore({ importMode: value });
    if (value) { syncGroups(); }
    return { ok: true };
  },

  async runNativeMacro() {
    return new Promise((resolve) => {
      // Çift yönlü kalıcı bağlantı (Port) açıldı
      nativePort = chrome.runtime.connectNative('com.tabgroup.master');
      
      nativePort.onMessage.addListener((msg) => {
        if (msg.status === "SUCCESS" || msg.status === "STOPPED") {
          nativePort.disconnect();
          nativePort = null;
          resolve({ ok: true, response: msg });
        }
      });

      nativePort.onDisconnect.addListener(() => {
        nativePort = null;
        resolve({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "Bağlantı koptu" });
      });

      // Python'a Başla sinyali gönder
      nativePort.postMessage({ command: "START_MACRO" });
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
    store.savedGroups[idx].active        = true;
    store.savedGroups[idx].chromeGroupId = chromeGroupId;
    await setStore({ savedGroups: store.savedGroups });
    await syncGroups();
    return { ok: true };
  },

  async deleteGroup({ groupUid }) {
    const store = await getStore();
    store.savedGroups = store.savedGroups.filter((g) => g.uid !== groupUid);
    store.conflicts = store.conflicts.filter((c) => c.savedGroupUid !== groupUid);
    store.categories.forEach((cat) => {
      cat.groupUids = (cat.groupUids || []).filter((u) => u !== groupUid);
    });
    await setStore({ savedGroups: store.savedGroups, conflicts: store.conflicts, categories: store.categories });
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

  async saveCategories({ categories }) {
    await setStore({ categories });
    return { ok: true };
  },
};

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

syncGroups();