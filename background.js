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
  // STORE_UPDATED is handled by storage.onChanged in each page — no sendMessage needed.
  // Sending to multiple pages with async handlers caused message-channel collisions
  // that silently killed the native messaging port.
  if (payload.type === "STORE_UPDATED") return;
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function normalizeTitle(value) {
  return String(value || "")
    // Turkish dotless-i has no NFD decomposition — must be explicit
    .replace(/İ/g, "i").replace(/ı/g, "i")
    // NFD decomposition strips all other diacritics (ç→c, ü→u, é→e, ñ→n …)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
    openWindowId: group.openWindowId ?? null,
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

// ── User settings ──────────────────────────────────────────────────────────────
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
  lazyRestore: true, // open saved groups as frozen tabs (huge RAM saver)
  freeMode: true,    // open groups in their own window, NOT as Chrome tab groups
                     // → nothing ever lands in Chrome's saved-groups / bookmarks bar
};

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function setSettings(partial) {
  const next = { ...(await getSettings()), ...(partial || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Build a frozen-tab URL that holds a real URL without loading it. */
function buildSuspendedUrl(tab) {
  // data:-URI favicons can be tens of KB — embedding them would bloat the tab
  // URL (and every storage/backup copy of it). Keep only reasonably short ones.
  const fav = tab.favIconUrl || "";
  const qs = new URLSearchParams({
    u: tab.url || "",
    t: tab.title || tab.url || "",
    f: fav.length <= 2048 ? fav : "",
  });
  return `${chrome.runtime.getURL("suspended.html")}?${qs.toString()}`;
}

async function setStore(partial) {
  await chrome.storage.local.set(partial);
  scheduleSyncBackup();
  scheduleFileBackup();
}

// ── Active-window tab tracking ────────────────────────────────────────────────
// Maps windowId → { groupUid, tabs: [{id, url, title}] }
// Built when restoreGroup (freeMode) opens a window; kept live as tabs change.
// When the window closes we write the final tab list back to the saved group,
// so changes made while the group is open (closed tabs, navigated URLs) are
// persisted rather than silently discarded.
//
// IMPORTANT: MV3 service workers go idle after ~30 s of no activity, losing
// in-memory state. We mirror the map to chrome.storage.session (survives SW
// restarts for the entire browser session) so a window closed after a long
// idle period still gets its tabs saved correctly.
const _activeWindows = new Map();
const _AW_KEY = "_aw";

function _isSuspended(url) {
  return url.startsWith(chrome.runtime.getURL("suspended.html"));
}
function _realUrl(url) {
  if (!_isSuspended(url)) return url;
  try { return new URL(url).searchParams.get("u") || url; } catch (_) { return url; }
}
function _realTitle(url, title) {
  if (!_isSuspended(url)) return title;
  try { return new URL(url).searchParams.get("t") || title; } catch (_) { return title; }
}

// Debounced write: coalesces rapid tab-event updates into one storage write.
let _awFlushTimer = null;
function _awPersist() {
  clearTimeout(_awFlushTimer);
  _awFlushTimer = setTimeout(() => {
    const obj = {};
    for (const [k, v] of _activeWindows) obj[k] = { groupUid: v.groupUid, tabs: v.tabs };
    chrome.storage.session.set({ [_AW_KEY]: obj }).catch(() => {});
  }, 300);
}

// Called once at SW startup to restore any windows that were open when the
// SW was last killed (e.g. 30-second idle timeout).
async function _awRestore() {
  try {
    const d = await chrome.storage.session.get(_AW_KEY);
    for (const [k, v] of Object.entries(d[_AW_KEY] || {})) {
      _activeWindows.set(Number(k), v);
    }
  } catch (_) {}
}

// ── File backup via NativeHost ────────────────────────────────────────────────
// Written to %LOCALAPPDATA%\TabGroupMaster\workspace_backup.json — SURVIVES
// Chrome profile resets because AppData is outside Chrome's profile directory.

let _fileBackupTimer = null;

function scheduleFileBackup() {
  clearTimeout(_fileBackupTimer);
  _fileBackupTimer = setTimeout(doFileBackup, 30_000); // 30-second debounce
}

async function doFileBackup() {
  try {
    const store = await getStore();
    // Strip favicon URLs before backup: they can be data: URIs (5-50 KB each),
    // inflating the payload past the 1 MB native-messaging limit.
    // Favicons are cosmetic — URL + title are enough to restore tabs.
    const savedGroups = store.savedGroups.map(g => ({
      ...g,
      tabs: (g.tabs || []).map(({ url, title }) => ({ url, title })),
    }));
    const payload = { v: 4, ts: Date.now(), savedGroups, folders: store.folders };
    await _nativeOneShot("saveBackup", { data: payload }, "saveBackupResult", 10_000);
  } catch (_) {}
}

async function restoreFromFileBackup() {
  try {
    const local = await chrome.storage.local.get(["savedGroups", "folders"]);
    if ((local.savedGroups || []).length > 0 || (local.folders || []).length > 0) return;
    const msg = await _nativeOneShot("loadBackup", {}, "loadBackupResult", 15_000, "loadBackupChunk");
    if (!msg?.ok || !msg.data?.savedGroups?.length) return;
    const savedGroups = (msg.data.savedGroups || []).map(normalizeGroup);
    const folders     = (msg.data.folders     || []).map(normalizeFolder);
    await chrome.storage.local.set({ savedGroups, folders });
    broadcast({ type: "RESTORED_FROM_BACKUP", groupCount: savedGroups.length, folderCount: folders.length });
  } catch (_) {}
}

// ── Native-host serialization lock ──────────────────────────────────────────
// Chrome/Windows is unreliable when two native-host ports are open at once
// (auto-backup colliding with Test Connection / Import is the classic case:
// the first works, the next "disconnects"). We funnel EVERY connectNative call
// through a single queue, with a short gap after each so the previous host
// process fully exits before the next one spawns.
let _nativeLock = Promise.resolve();
const _delay = (ms) => new Promise((r) => setTimeout(r, ms));
function _withNativeLock(task) {
  const run = _nativeLock.then(task, task);
  // Keep the chain alive even if a task throws; add a 250ms cooldown gap.
  _nativeLock = run.then(() => _delay(250), () => _delay(250));
  return run;
}

/** Open a native port, send one message, wait for one response, then disconnect.
 *  If chunkAction is given, intermediate chunk messages are reassembled into
 *  result.data (hosts must chunk anything that could exceed Chrome's 1 MB
 *  host→extension message limit). */
function _nativeOneShot(action, extra, expectedAction, timeoutMs, chunkAction) {
  return _withNativeLock(() => new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(NATIVE_HOST_NAME); } catch (_) { resolve(null); return; }
    if (!port) { resolve(null); return; }
    let done = false;
    const chunks = [];
    const finish = (v) => {
      if (done) return; done = true;
      clearTimeout(t);
      try { port.disconnect(); } catch (_) {}
      resolve(v);
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    port.onDisconnect.addListener(() => finish(null));
    port.onMessage.addListener((m) => {
      if (chunkAction && m?.action === chunkAction) { chunks[m.index] = m.data; return; }
      if (m?.action !== expectedAction) return;
      if (m.chunked) {
        try { m.data = JSON.parse(chunks.join("")); }
        catch (_) { finish(null); return; }
      }
      finish(m);
    });
    port.postMessage({ action, ...extra });
  }));
}

// ── Cloud backup ─────────────────────────────────────────────────────────────
// Keeps a compact copy in chrome.storage.sync so data survives profile sign-outs.
// Tabs are NOT backed up (they can be re-imported from Chrome).

const SYNC_META_KEY = "bkmeta";
const SYNC_CHUNK_KEY = "bk";
const SYNC_CHUNK_SIZE = 7800; // safely under Chrome's 8192 bytes/item limit

let _syncTimer = null;

function scheduleSyncBackup() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(doSyncBackup, 8000); // 8-second debounce — don't hammer sync
}

async function doSyncBackup() {
  try {
    const store = await getStore();
    const payload = JSON.stringify({
      v: 3, ts: Date.now(),
      g: store.savedGroups.map(g => [
        g.uid, g.title || "", g.color || "grey",
        g.folderId || null, g.tabCount || 0, g.savedAt || 0,
      ]),
      f: store.folders,
    });
    const chunks = [];
    for (let i = 0; i < payload.length; i += SYNC_CHUNK_SIZE) {
      chunks.push(payload.slice(i, i + SYNC_CHUNK_SIZE));
    }
    const obj = { [SYNC_META_KEY]: { n: chunks.length, ts: Date.now(), gc: store.savedGroups.length } };
    chunks.forEach((c, i) => { obj[SYNC_CHUNK_KEY + i] = c; });
    await chrome.storage.sync.set(obj);
    // Remove stale extra chunks from a previous larger backup
    const staleKeys = Array.from({ length: 20 }, (_, i) => SYNC_CHUNK_KEY + (chunks.length + i));
    chrome.storage.sync.remove(staleKeys).catch(() => {});
  } catch (_) { /* quota exceeded or sync disabled — skip silently */ }
}

async function restoreFromCloud() {
  try {
    const meta = (await chrome.storage.sync.get(SYNC_META_KEY))[SYNC_META_KEY];
    if (!meta?.n) return;
    const chunkKeys = Array.from({ length: meta.n }, (_, i) => SYNC_CHUNK_KEY + i);
    const chunks = await chrome.storage.sync.get(chunkKeys);
    const json = chunkKeys.map(k => chunks[k] || "").join("");
    if (!json) return;
    const data = JSON.parse(json);
    if (!Array.isArray(data?.g) || !data.g.length) return;

    const local = await chrome.storage.local.get(["savedGroups", "folders"]);
    const localGroups = local.savedGroups || [];

    // If local already has data, only merge groups that are missing locally
    // (preserving existing tab URLs — cloud stores only counts).
    if (localGroups.length > 0) {
      const localUids = new Set(localGroups.map(g => g.uid));
      const cloudOnly = data.g
        .filter(([u]) => !localUids.has(u))
        .map(([u, t, c, f, n, s]) => normalizeGroup({
          uid: u, title: t, color: c, folderId: f,
          tabCount: n, savedAt: s,
          active: false, chromeGroupId: null, tabs: [], tabsLoaded: false,
        }));
      if (!cloudOnly.length) return;
      await chrome.storage.local.set({ savedGroups: [...localGroups, ...cloudOnly] });
      broadcast({ type: "STORE_UPDATED" });
      return;
    }

    // Local is empty — full restore from cloud (last resort)
    const savedGroups = data.g.map(([u, t, c, f, n, s]) => normalizeGroup({
      uid: u, title: t, color: c, folderId: f,
      tabCount: n, savedAt: s,
      active: false, chromeGroupId: null, tabs: [], tabsLoaded: false,
    }));
    const folders = (data.f || []).map(normalizeFolder);
    await chrome.storage.local.set({ savedGroups, folders });
    broadcast({ type: "RESTORED_FROM_CLOUD", groupCount: savedGroups.length, folderCount: folders.length });
  } catch (_) { /* restore failed — skip silently */ }
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
      tabs: tabs.map(t => ({ url: _realUrl(t.url || ""), title: _realTitle(t.url || "", t.title || "") }))
        .filter(t => t.url && !t.url.startsWith("chrome://")),
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
  const liveWindowIds = new Set((await chrome.windows.getAll()).map((w) => w.id));
  const groups = store.savedGroups;

  // Snapshot key fields BEFORE mutation so we can skip setStore if nothing changed.
  const oldSig = groups.map(g => `${g.uid}:${g.active}:${g.chromeGroupId}:${g.openWindowId}`).join("|");
  const oldLen = groups.length;

  for (const g of groups) {
    if (!g.active) continue;
    // Free-mode groups live in their own window: active iff that window exists.
    if (g.openWindowId != null) {
      if (!liveWindowIds.has(g.openWindowId)) {
        g.active = false;
        g.openWindowId = null;
      } else if (!_activeWindows.has(g.openWindowId)) {
        // Service worker was restarted — rebuild the tracking map for this window.
        const winId = g.openWindowId;
        const groupUid = g.uid;
        chrome.tabs.query({ windowId: winId }).then(tabs => {
          _activeWindows.set(winId, {
            groupUid,
            tabs: tabs.map(t => ({
              id: t.id,
              url: _realUrl(t.url || t.pendingUrl || ""),
              title: _realTitle(t.url || "", t.title || ""),
            })).filter(t => t.url && !t.url.startsWith("chrome://")),
          });
          _awPersist();
        }).catch(() => {});
      }
      continue; // never treat window-based groups as Chrome tab groups
    }
    // Legacy Chrome-tab-group: active iff the group still exists in the strip.
    if (!liveIds.has(g.chromeGroupId)) {
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

  // Only persist + broadcast if something actually changed (avoids spurious
  // file-backup triggers every time any tab event fires).
  const newSig = groups.map(g => `${g.uid}:${g.active}:${g.chromeGroupId}:${g.openWindowId}`).join("|");
  if (groups.length !== oldLen || newSig !== oldSig) {
    await setStore({ savedGroups: groups });
    broadcast({ type: "STORE_UPDATED" });
  }
}

const NATIVE_INSTALL_HINT =
  "Run the installer in the NativeHost folder (install.bat on Windows, " +
  "install.command on macOS, install.sh on Linux), then restart your browser.";

function _connectNative(onMsg, onError) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (_) {
    onError("Native host not found. " + NATIVE_INSTALL_HINT);
    return null;
  }
  if (!port) {
    onError("Native host not found. " + NATIVE_INSTALL_HINT);
    return null;
  }
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    onError(err || "Native host disconnected. " + NATIVE_INSTALL_HINT);
  });
  port.onMessage.addListener(onMsg);
  return port;
}

function _listChromeProfilesOnce() {
  return _withNativeLock(() => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch (_) {}
      resolve(result);
    };
    const port = _connectNative(
      (msg) => {
        if (msg?.action !== "listProfilesResult") return;
        finish(msg);
      },
      (err) => finish({ ok: false, error: err, profiles: [] })
    );
    if (!port) return;
    const timer = setTimeout(() => finish({ ok: false, error: "Timed out waiting for native host", profiles: [] }), 10_000);
    port.postMessage({ action: "listProfiles" });
  }));
}

// listChromeProfiles is the entry point for BOTH Test Connection and Import.
// A native port can disconnect transiently (e.g. a leftover host process from a
// previous op hasn't fully exited yet — the classic "first works, next drops").
// One automatic retry after a short settle lets the queue self-heal so the user
// doesn't see a spurious failure.
async function listChromeProfiles() {
  const first = await _listChromeProfilesOnce();
  if (first?.ok) return first;
  await _delay(400);
  const second = await _listChromeProfilesOnce();
  // Prefer the successful/most-informative result.
  return second?.ok ? second : (second || first);
}

function importFromChrome(profileDirs = null) {
  return _withNativeLock(() => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch (_) {}
      resolve(result);
    };
    // Chrome caps host->extension messages at 1 MB, so the host streams the
    // export as multiple "extractChunk" messages, then a final "extractResult".
    const chunks = [];
    const port = _connectNative(
      async (msg) => {
        if (msg?.action === "extractChunk") {
          chunks[msg.index] = msg.data;
          return;
        }
        if (msg?.action !== "extractResult") return;
        if (!msg.ok) { finish({ ok: false, error: msg.error || "Extraction failed" }); return; }
        let data;
        if (msg.chunked) {
          try {
            data = JSON.parse(chunks.join(""));
          } catch (e) {
            finish({ ok: false, error: "Could not reassemble data (chunk error): " + e.message });
            return;
          }
        } else {
          data = msg.data; // backward-compat with old single-message host
        }
        const res = await importStore(data);
        finish({ ok: true, added: res.added, total: (data?.savedGroups || []).length });
      },
      (err) => finish({ ok: false, error: err })
    );
    if (!port) return;
    const timer = setTimeout(
      () => finish({ ok: false, error: "Timed out waiting for native host" }),
      IMPORT_TIMEOUT_MS
    );
    port.postMessage({ action: "extract", profileDirs });
  }));
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

// ── Service worker keepalive ──────────────────────────────────────────────────
// MV3 service workers die after ~30s of inactivity. An alarm every minute
// keeps the SW alive so the dashboard can always send messages to it.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    /* just waking up is enough — do nothing */
  }
});

// When a free-mode window is closed, mark its group inactive immediately.
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Grab the last-known tab list before discarding the tracking entry.
  const tracked = _activeWindows.get(windowId);
  _activeWindows.delete(windowId);
  _awPersist();

  const store = await getStore();
  let changed = false;
  for (const g of store.savedGroups) {
    if (g.openWindowId !== windowId) continue;
    // Write the final tab state back so manual changes (closed tabs,
    // navigations) survive the next time the group is opened.
    if (tracked?.tabs.length) {
      g.tabs = tracked.tabs.map(({ url, title }) => ({ url, title }));
      g.tabCount = g.tabs.length;
      g.tabsLoaded = true;
    }
    g.active = false;
    g.openWindowId = null;
    changed = true;
  }
  if (changed) {
    await setStore({ savedGroups: store.savedGroups });
    // storage.onChanged notifies all pages — no explicit sendMessage needed.
  }
});

chrome.tabGroups.onCreated.addListener(scheduleReconcile);
chrome.tabGroups.onUpdated.addListener(scheduleReconcile);
chrome.tabGroups.onRemoved.addListener(scheduleReconcile);
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) {
    // Individual tab close — remove from tracking map and update stored tabCount
    // immediately so the sidepanel reflects the real count in real-time.
    for (const data of _activeWindows.values()) {
      const idx = data.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) {
        data.tabs.splice(idx, 1);
        _awPersist();
        const store = await getStore();
        const g = store.savedGroups.find(sg => sg.uid === data.groupUid);
        if (g) { g.tabCount = data.tabs.length; await setStore({ savedGroups: store.savedGroups }); }
        break;
      }
    }
  }
  scheduleReconcile();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  // Track tabs added to an active group window after it was opened.
  const data = _activeWindows.get(tab.windowId);
  if (data && tab.url && !tab.url.startsWith("chrome://") && !_isSuspended(tab.url)) {
    data.tabs.push({ id: tab.id, url: tab.url, title: tab.title || "" });
    _awPersist();
    const store = await getStore();
    const g = store.savedGroups.find(sg => sg.uid === data.groupUid);
    if (g) { g.tabCount = data.tabs.length; await setStore({ savedGroups: store.savedGroups }); }
  }
  scheduleReconcile();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // Keep tracking map current when a tab navigates or its title changes.
  if (info.url || info.title) {
    let changed = false;
    for (const data of _activeWindows.values()) {
      const tracked = data.tabs.find(t => t.id === tabId);
      if (tracked) {
        if (info.url) tracked.url = _realUrl(info.url);
        if (info.title) tracked.title = info.title;
        changed = true;
      } else if (info.url && !info.url.startsWith("chrome://") && !_isSuspended(info.url)
                 && _activeWindows.has(tab.windowId)) {
        // Tab started as chrome://newtab and navigated to a real page — add it now.
        _activeWindows.get(tab.windowId).tabs.push({
          id: tabId,
          url: _realUrl(info.url),
          title: info.title || tab.title || "",
        });
        changed = true;
      }
    }
    if (changed) _awPersist();
  }
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

  async listChromeProfiles() {
    return listChromeProfiles();
  },

  async importFromChrome({ profileDirs } = {}) {
    return importFromChrome(profileDirs || null);
  },

  async loadGroupTabs({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };

    // Already have tabs — return them
    if (group.tabsLoaded && group.tabs?.length) return { ok: true, tabs: group.tabs };

    // Try _activeWindows first (fastest, no Chrome API needed)
    if (group.openWindowId != null) {
      const tracked = _activeWindows.get(group.openWindowId);
      if (tracked?.tabs?.length) {
        group.tabs = tracked.tabs.map(({ url, title }) => ({ url, title }));
        group.tabCount = group.tabs.length;
        group.tabsLoaded = true;
        await setStore({ savedGroups: store.savedGroups });
        return { ok: true, tabs: group.tabs };
      }
    }
    // Try Chrome tab group (non-freeMode active groups)
    if (group.active && group.chromeGroupId != null) {
      const tabs = await readLiveTabs(group.chromeGroupId).catch(() => []);
      if (tabs.length) {
        group.tabs = tabs;
        group.tabCount = tabs.length;
        group.tabsLoaded = true;
        await setStore({ savedGroups: store.savedGroups });
        return { ok: true, tabs };
      }
    }
    // Try open window directly
    if (group.openWindowId != null) {
      const winTabs = await chrome.tabs.query({ windowId: group.openWindowId }).catch(() => []);
      const mapped = winTabs
        .map(t => ({ url: _realUrl(t.url || ""), title: _realTitle(t.url || "", t.title || "") }))
        .filter(t => t.url && !t.url.startsWith("chrome://"));
      if (mapped.length) {
        group.tabs = mapped;
        group.tabCount = mapped.length;
        group.tabsLoaded = true;
        await setStore({ savedGroups: store.savedGroups });
        return { ok: true, tabs: mapped };
      }
    }
    return { ok: true, tabs: group.tabs || [] };
  },

  async restoreGroup({ groupUid, lazy }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };

    // Tabs missing — try every recovery path before giving up.
    if (!group.tabs?.length) {
      // Path 1: window is open and tracked in _activeWindows
      if (group.openWindowId != null) {
        const tracked = _activeWindows.get(group.openWindowId);
        if (tracked?.tabs?.length) {
          group.tabs = tracked.tabs.map(({ url, title }) => ({ url, title }));
          group.tabCount = group.tabs.length;
          group.tabsLoaded = true;
        }
      }
      // Path 2: active Chrome tab group — query live
      if (!group.tabs?.length && group.active && group.chromeGroupId != null) {
        const liveTabs = await readLiveTabs(group.chromeGroupId).catch(() => []);
        if (liveTabs.length) {
          group.tabs = liveTabs;
          group.tabCount = liveTabs.length;
          group.tabsLoaded = true;
        }
      }
      // Path 3: freeMode window open — query by windowId
      if (!group.tabs?.length && group.openWindowId != null) {
        const winTabs = await chrome.tabs.query({ windowId: group.openWindowId }).catch(() => []);
        const mapped = winTabs
          .map(t => ({ url: _realUrl(t.url || ""), title: _realTitle(t.url || "", t.title || "") }))
          .filter(t => t.url && !t.url.startsWith("chrome://"));
        if (mapped.length) {
          group.tabs = mapped;
          group.tabCount = mapped.length;
          group.tabsLoaded = true;
        }
      }
      if (group.tabs?.length) {
        await setStore({ savedGroups: store.savedGroups });
      } else {
        return { ok: false, error: "No tabs stored for this group" };
      }
    }

    const settings = await getSettings();
    const useLazy = lazy === undefined ? settings.lazyRestore !== false : !!lazy;
    const freeMode = settings.freeMode !== false;

    // If it's already open, just focus it instead of opening twice.
    if (group.active) {
      if (group.openWindowId != null) {
        try { await chrome.windows.update(group.openWindowId, { focused: true }); return { ok: true, focused: true }; }
        catch (_) { /* window gone — fall through and reopen */ }
      }
      return { ok: false, error: "Group is already open" };
    }

    const urls = group.tabs
      .filter(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://"))
      .map(t => (useLazy ? buildSuspendedUrl(t) : t.url));
    if (urls.length === 0) return { ok: false, error: "No restorable tabs" };

    if (freeMode) {
      // ── FREE MODE: own window, no Chrome tab group ──────────────────────────
      // Chrome never creates a "saved tab group", so nothing pollutes the
      // bookmarks bar. The group lives entirely inside TabGroup Master.
      const win = await chrome.windows.create({ url: urls, focused: true });
      group.active = true;
      group.openWindowId = win.id;
      group.chromeGroupId = null;

      // Seed the tracking map so tab changes (closes, navigations) are captured.
      // windows.create resolves after all tabs are created, so the query is safe.
      const seedTabs = await chrome.tabs.query({ windowId: win.id });
      _activeWindows.set(win.id, {
        groupUid: group.uid,
        tabs: seedTabs.map(t => ({
          id: t.id,
          url: _realUrl(t.url || t.pendingUrl || ""),
          title: _realTitle(t.url || "", t.title || ""),
        })).filter(t => t.url && !t.url.startsWith("chrome://")),
      });
      _awPersist();

      await setStore({ savedGroups: store.savedGroups });
      broadcast({ type: "STORE_UPDATED" });
      return { ok: true, freeMode: true, lazy: useLazy, count: urls.length, windowId: win.id };
    }

    // ── LEGACY MODE: native Chrome tab group in the current window ─────────────
    const window = await chrome.windows.getCurrent();
    const tabIds = [];
    for (const url of urls) {
      const created = await chrome.tabs.create({ url, windowId: window.id, active: false });
      tabIds.push(created.id);
    }
    const chromeGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: window.id } });
    await chrome.tabGroups.update(chromeGroupId, { title: group.title, color: group.color });
    group.active = true;
    group.chromeGroupId = chromeGroupId;
    group.openWindowId = null;
    await setStore({ savedGroups: store.savedGroups });
    await reconcile();
    return { ok: true, freeMode: false, lazy: useLazy, count: tabIds.length };
  },

  // ── Close an open group (close its window or ungroup), keep it saved ─────────
  async closeGroup({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };

    if (group.openWindowId != null) {
      // Save current tab state before closing the window
      const tracked = _activeWindows.get(group.openWindowId);
      if (tracked?.tabs.length) {
        group.tabs = tracked.tabs.map(({ url, title }) => ({ url, title }));
        group.tabCount = group.tabs.length;
        group.tabsLoaded = true;
      }
      _activeWindows.delete(group.openWindowId);
      _awPersist();
      try { await chrome.windows.remove(group.openWindowId); } catch (_) {}
    } else if (group.chromeGroupId != null) {
      try {
        // Save current tab state from the Chrome tab group before closing
        const liveTabs = await readLiveTabs(group.chromeGroupId);
        if (liveTabs.length) {
          group.tabs = liveTabs;
          group.tabCount = liveTabs.length;
          group.tabsLoaded = true;
        }
        const tabIds = (await chrome.tabs.query({ groupId: group.chromeGroupId })).map(t => t.id).filter(Boolean);
        if (tabIds.length) await chrome.tabs.remove(tabIds);
      } catch (_) {}
    }
    group.active = false;
    group.openWindowId = null;
    group.chromeGroupId = null;
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  // ── Bring an open group's window to the front ────────────────────────────────
  async focusGroupWindow({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    if (group.openWindowId != null) {
      try { await chrome.windows.update(group.openWindowId, { focused: true }); return { ok: true }; }
      catch (_) { return { ok: false }; }
    }
    if (group.chromeGroupId != null) {
      try {
        const g = await chrome.tabGroups.get(group.chromeGroupId);
        await chrome.windows.update(g.windowId, { focused: true });
        return { ok: true };
      } catch (_) {}
    }
    return { ok: false };
  },

  async deleteGroup({ groupUid }) {
    const store = await getStore();
    const savedGroups = store.savedGroups.filter((g) => g.uid !== groupUid);
    await setStore({ savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async saveWindowAsGroup({ windowId, title }) {
    const allTabs = await chrome.tabs.query({ windowId });
    const tabs = allTabs
      .filter(t => {
        const u = t.url || t.pendingUrl || "";
        return u && !u.startsWith("chrome://") && !u.startsWith("chrome-extension://") && !u.startsWith("about:");
      })
      .map(t => ({
        id: t.id,
        url: _realUrl(t.url || t.pendingUrl || ""),
        title: _realTitle(t.url || "", t.title || ""),
      }));
    if (!tabs.length) return { ok: false, error: "No saveable tabs in this window" };

    const groupTitle = (title || "").trim() || tabs[0].title || "Captured Window";
    const newGroup = normalizeGroup({
      uid: uid(),
      title: groupTitle,
      color: "grey",
      tabs: tabs.map(({ url, title: t }) => ({ url, title: t })),
      tabCount: tabs.length,
      tabsLoaded: true,
      active: true,
      openWindowId: windowId,
    });

    const store = await getStore();
    store.savedGroups.unshift(newGroup);
    await setStore({ savedGroups: store.savedGroups });

    // Seed tracking map — closing this window will auto-save final tab state
    _activeWindows.set(windowId, { groupUid: newGroup.uid, tabs });
    _awPersist();

    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, groupUid: newGroup.uid, tabCount: tabs.length };
  },

  async restoreDeletedGroup({ group }) {
    if (!group || !group.uid) return { ok: false };
    const store = await getStore();
    if (store.savedGroups.some(g => g.uid === group.uid)) return { ok: true };
    store.savedGroups.unshift(normalizeGroup({ ...group, active: false, openWindowId: null, chromeGroupId: null }));
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  // Bulk undo for "Delete selected" — restores all snapshots in one storage write.
  async restoreDeletedGroups({ groups }) {
    if (!Array.isArray(groups) || !groups.length) return { ok: false };
    const store = await getStore();
    const existing = new Set(store.savedGroups.map(g => g.uid));
    let restored = 0;
    for (const group of groups) {
      if (!group?.uid || existing.has(group.uid)) continue;
      store.savedGroups.unshift(normalizeGroup({ ...group, active: false, openWindowId: null, chromeGroupId: null }));
      existing.add(group.uid);
      restored++;
    }
    if (restored) {
      await setStore({ savedGroups: store.savedGroups });
      broadcast({ type: "STORE_UPDATED" });
    }
    return { ok: true, restored };
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

  // ── Create a brand-new group (from scratch, no open Chrome tabs needed) ──────
  async createGroup({ title, color, tabs }) {
    const store = await getStore();
    const newGroup = normalizeGroup({
      title: (title || "").trim() || "New Group",
      color: color || "grey",
      tabs: (tabs || [])
        .map(t => ({ url: (t.url || "").trim(), title: (t.title || t.url || "").trim() }))
        .filter(t => t.url),
      active: false,
      chromeGroupId: null,
      folderId: null,
      savedAt: Date.now(),
    });
    store.savedGroups.push(newGroup);
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, group: newGroup };
  },

  // ── Replace the tab list for an existing saved group ─────────────────────────
  async updateGroupTabs({ groupUid, tabs }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    group.tabs = (tabs || [])
      .map(t => ({ url: (t.url || "").trim(), title: (t.title || t.url || "").trim() }))
      .filter(t => t.url);
    group.tabCount = group.tabs.length;
    group.tabsLoaded = true;
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  // ── Persist a user-defined ordering for savedGroups (drag-and-drop) ──────────
  async reorderGroups({ orderedUids }) {
    if (!Array.isArray(orderedUids)) return { ok: false };
    const store = await getStore();
    const byUid = new Map(store.savedGroups.map(g => [g.uid, g]));
    const reordered = orderedUids.map(u => byUid.get(u)).filter(Boolean);
    const reorderedSet = new Set(orderedUids);
    const rest = store.savedGroups.filter(g => !reorderedSet.has(g.uid));
    await setStore({ savedGroups: [...reordered, ...rest] });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async getSettings() {
    return { ok: true, settings: await getSettings() };
  },

  async updateSettings({ settings }) {
    return { ok: true, settings: await setSettings(settings || {}) };
  },
};

// On startup: restore active-window tracking first (survives SW idle restarts),
// then cloud backup, then file backup, then reconcile.
// Startup restore priority:
// 1. _awRestore   — in-memory window tracking (session storage)
// 2. restoreFromFileBackup — full tab URLs preserved (v4 format), preferred
// 3. restoreFromCloud     — last resort; only tab counts, no URLs
// Both backup restores skip when local storage is already non-empty.
_awRestore()
  .then(() => restoreFromFileBackup())
  .then(() => restoreFromCloud())
  .then(() => reconcile());

// Keyboard shortcut: Ctrl+Shift+G → save focused window as group
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "save-window-as-group") return;
  const win = await chrome.windows.getLastFocused({ populate: false });
  if (!win || win.type !== "normal") return;
  const res = await handlers.saveWindowAsGroup({ windowId: win.id, title: "" });
  if (res.ok) {
    // Flash the sidepanel open so user sees the new group
    chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
});
