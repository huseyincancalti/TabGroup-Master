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
    // Cloud-restored groups have a tab count but no stored URLs — flagged so
    // the UI can label them instead of showing a misleading count. Cleared the
    // moment real tabs are stored (see clearing logic where tabs are written).
    tabsUnstored: group.tabsUnstored === true,
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

// ── Deleted-group memory (tombstones) ───────────────────────────────────────
// Remembers groups the user has deleted so re-importing from Chrome doesn't keep
// resurrecting them — Chrome still has them in its synced DB. A tombstone is
// cleared per-group on Undo, or wholesale via "Clear import history" in Settings.
const DELETED_KEYS = "deletedGroupKeys";
const MAX_DELETED_KEYS = 800;

// ── Tab-level deduplication helpers ──────────────────────────────────────────

const _TRACKING_PARAMS = [
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
  "fbclid","gclid","_ga","_gl","ref","source",
];

function normalizeTabUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    _TRACKING_PARAMS.forEach(p => u.searchParams.delete(p));
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, "");
    return u.toString();
  } catch (_) {
    return url.trim().toLowerCase();
  }
}

function normalizeTabTitle(title) {
  if (!title) return "";
  return title.trim()
    .replace(/\s*[–\-]\s*\d+\s*$/, "")
    .replace(/\s*#\d+\s*$/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .toLowerCase();
}

function findTabDuplicateIndices(tabs) {
  const seenUrls = new Map();
  const seenTitleKeys = new Map();
  const toRemove = [];
  tabs.forEach((t, i) => {
    if (!t.url) return;
    const normUrl = normalizeTabUrl(t.url);
    if (seenUrls.has(normUrl)) { toRemove.push(i); return; }
    seenUrls.set(normUrl, i);
    const normTitle = normalizeTabTitle(t.title || "");
    if (normTitle.length > 4) {
      try {
        const host = new URL(t.url).hostname.replace(/^www\./, "").toLowerCase();
        const key = `${host}::${normTitle}`;
        if (seenTitleKeys.has(key)) { toRemove.push(i); return; }
        seenTitleKeys.set(key, i);
      } catch (_) {}
    }
  });
  return toRemove.sort((a, b) => b - a); // descending so splice keeps indices valid
}

// Identity that survives re-import. MUST be stable whether or not the group's
// tabs are loaded — groups are lazy, so a deleted group often has tabs:[] and
// only a tabCount. Earlier this mixed in tab hostnames, so the tombstone written
// at delete time ("title::") never matched the re-imported group ("title::hosts")
// and deleted groups kept coming back. Fix: a titled group is identified by its
// normalized title alone (always present); only unnamed groups fall back to hosts.
function groupSignature(g) {
  const title = normalizeTitle(g?.title || "");
  if (title) return "t:" + title;
  const hosts = [...new Set((g?.tabs || []).map((t) => {
    try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }).filter(Boolean))].sort().join(",");
  return hosts ? "h:" + hosts : "";
}

async function getDeletedKeys() {
  const d = await chrome.storage.local.get(DELETED_KEYS);
  return new Set(Array.isArray(d[DELETED_KEYS]) ? d[DELETED_KEYS] : []);
}

async function addDeletedKeys(groups) {
  const set = await getDeletedKeys();
  for (const g of groups) {
    const sig = groupSignature(g);
    if (sig) set.add(sig);
  }
  let arr = [...set];
  if (arr.length > MAX_DELETED_KEYS) arr = arr.slice(arr.length - MAX_DELETED_KEYS);
  await chrome.storage.local.set({ [DELETED_KEYS]: arr });
}

async function removeDeletedKeys(groups) {
  const set = await getDeletedKeys();
  for (const g of groups) set.delete(groupSignature(g));
  await chrome.storage.local.set({ [DELETED_KEYS]: [...set] });
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

// Per-profile backup key. chrome.storage.local is NOT synced and is unique to
// this browser profile, so a key kept here isolates THIS profile's file backup
// from every other profile/account on the same machine. Without it, all
// profiles shared a single workspace_backup.json and could overwrite or restore
// each other's data — the root cause of "groups from another account appeared
// and my own groups vanished".
const _BK_KEY = "_backupKey";
let _backupKeyCache = null;
async function getBackupKey() {
  if (_backupKeyCache) return _backupKeyCache;
  const d = await chrome.storage.local.get(_BK_KEY);
  let key = d[_BK_KEY];
  if (!key) {
    key = (self.crypto?.randomUUID)
      ? self.crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    await chrome.storage.local.set({ [_BK_KEY]: key });
  }
  _backupKeyCache = key;
  return key;
}

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
    const key = await getBackupKey();
    await _nativeOneShot("saveBackup", { data: payload, key }, "saveBackupResult", 10_000);
  } catch (_) {}
}

// Read THIS profile's file backup (no writes). Returns parsed data or null.
// Never called automatically — only when the user explicitly asks to recover.
async function _readFileBackup() {
  try {
    const key = await getBackupKey();
    const msg = await _nativeOneShot("loadBackup", { key }, "loadBackupResult", 15_000, "loadBackupChunk");
    if (!msg?.ok || !msg.data?.savedGroups?.length) return null;
    return msg.data;
  } catch (_) { return null; }
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

// Read the cloud backup payload (no writes). Returns null if none/invalid.
async function _readCloudBackup() {
  const meta = (await chrome.storage.sync.get(SYNC_META_KEY))[SYNC_META_KEY];
  if (!meta?.n) return null;
  const chunkKeys = Array.from({ length: meta.n }, (_, i) => SYNC_CHUNK_KEY + i);
  const chunks = await chrome.storage.sync.get(chunkKeys);
  const json = chunkKeys.map(k => chunks[k] || "").join("");
  if (!json) return null;
  const data = JSON.parse(json);
  if (!Array.isArray(data?.g) || !data.g.length) return null;
  return data;
}

// ── Data recovery (EXPLICIT only — never automatic, never destructive) ───────
// Offered to the user via a banner; applied ONLY when they click Restore.
// Prefers this profile's local file backup (full tab URLs) and falls back to
// the cloud copy (tab counts only). Both paths MERGE new groups into local —
// they never overwrite or delete what's already there, so an accidental or
// repeated restore can't lose data.
async function getRecoveryStatus() {
  try {
    const local = await chrome.storage.local.get(["savedGroups"]);
    const localUids = new Set((local.savedGroups || []).map(g => g.uid));

    const file = await _readFileBackup();
    if (file?.savedGroups?.length) {
      const newCount = file.savedGroups.filter(g => !localUids.has(g.uid)).length;
      if (newCount > 0) return { available: true, source: "file", groupCount: newCount, hasTabs: true };
    }
    const cloud = await _readCloudBackup();
    if (cloud?.g?.length) {
      const newCount = cloud.g.filter(([u]) => !localUids.has(u)).length;
      if (newCount > 0) return { available: true, source: "cloud", groupCount: newCount, hasTabs: false };
    }
    return { available: false };
  } catch (_) { return { available: false }; }
}

async function applyRecovery({ source } = {}) {
  try {
    const local = await chrome.storage.local.get(["savedGroups", "folders"]);
    const localGroups = local.savedGroups || [];
    const localFolders = local.folders || [];
    const localUids = new Set(localGroups.map(g => g.uid));
    const localFolderIds = new Set(localFolders.map(f => f.id));

    let restored = [];
    let newFolders = [];

    if (source === "cloud") {
      const cloud = await _readCloudBackup();
      if (!cloud) return { ok: false, restored: 0 };
      restored = cloud.g
        .filter(([u]) => !localUids.has(u))
        .map(([u, t, c, f, n, s]) => normalizeGroup({
          uid: u, title: t, color: c, folderId: f, tabCount: n, savedAt: s,
          active: false, chromeGroupId: null, tabs: [], tabsLoaded: false,
          tabsUnstored: n > 0,
        }));
      newFolders = (cloud.f || []).map(normalizeFolder).filter(f => !localFolderIds.has(f.id));
    } else {
      const file = await _readFileBackup();
      if (!file) return { ok: false, restored: 0 };
      restored = (file.savedGroups || [])
        .filter(g => !localUids.has(g.uid))
        .map(g => normalizeGroup({ ...g, active: false, openWindowId: null, chromeGroupId: null }));
      newFolders = (file.folders || []).map(normalizeFolder).filter(f => !localFolderIds.has(f.id));
    }

    if (!restored.length && !newFolders.length) return { ok: true, restored: 0 };
    // MERGE only — existing local groups are preserved untouched.
    await chrome.storage.local.set({
      savedGroups: [...localGroups, ...restored],
      folders: [...localFolders, ...newFolders],
    });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, restored: restored.length, folders: newFolders.length };
  } catch (_) { return { ok: false, restored: 0 }; }
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

// Reconcile keeps the saved store's ACTIVE/INACTIVE state in sync with what's
// really open in the browser, and surfaces native Chrome tab groups the user
// creates so they appear in Active automatically (Pass 2 below).
//
// What it must NEVER do: pull in the synced/closed ghost groups from other
// accounts. Those came from the LevelDB native IMPORT path, never from the
// live chrome.tabGroups API. chrome.tabGroups.query returns only groups that
// are physically open in this session, so live capture is safe — and Pass 2
// additionally skips 0-tab groups, tombstoned (deleted) groups, and anything
// already represented in the store. Bulk import from Chrome stays explicit.
async function reconcileInner() {
  const store = await getStore();
  const live = await snapshotLiveGroups();
  const liveById = new Map(live.map((g) => [g.chromeGroupId, g]));
  const liveWindowIds = new Set((await chrome.windows.getAll()).map((w) => w.id));
  const groups = store.savedGroups;

  // Snapshot key fields BEFORE mutation so we can skip setStore if nothing changed.
  // tabCount is included so live tab additions/removals get persisted.
  const sig = (gs) => gs.map(g => `${g.uid}:${g.active}:${g.chromeGroupId}:${g.openWindowId}:${g.tabCount}`).join("|");
  const oldSig = sig(groups);

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

    // Legacy Chrome-tab-group (only created when freeMode is OFF and the
    // extension itself restored the group). Active iff it still exists.
    const liveMatch = liveById.get(g.chromeGroupId);
    if (!liveMatch) {
      g.active = false;
      g.chromeGroupId = null;
    } else {
      // Keep the saved copy current WHILE it's open, so closing it from
      // Chrome's UI (which fires onRemoved after the tabs are already gone)
      // doesn't lose the tab list.
      g.title = liveMatch.title || g.title;
      g.color = liveMatch.color || g.color;
      g.tabCount = liveMatch.tabCount;
      if (Array.isArray(liveMatch.tabs) && liveMatch.tabs.length) {
        g.tabs = liveMatch.tabs;
        g.tabsLoaded = true;
      }
    }
  }

  // ── Pass 2: surface live Chrome tab groups the user created natively ─────────
  // chrome.tabGroups.query (inside snapshotLiveGroups) returns ONLY groups that
  // are physically open in the current session — never the synced/closed ghost
  // groups from other accounts that caused the old data-loss (those came from
  // the LevelDB native import, not this live API). Guards keep it safe:
  //   • skip groups with 0 real tabs (the "ghost" shape from sync remnants)
  //   • skip groups already mapped to a saved group (by chromeGroupId)
  //   • re-link an existing INACTIVE saved group instead of duplicating it
  //   • skip groups the user deleted (tombstones)
  const mappedChromeIds = new Set(groups.filter(g => g.chromeGroupId != null).map(g => g.chromeGroupId));
  const savedBySig = new Map();
  for (const g of groups) {
    const s = groupSignature(g);
    if (s && !savedBySig.has(s)) savedBySig.set(s, g);
  }
  const deleted = await getDeletedKeys();
  const capturedSigs = new Set();

  for (const lg of live) {
    if (!lg.tabs || lg.tabs.length === 0) continue;          // ghost guard
    if (mappedChromeIds.has(lg.chromeGroupId)) continue;     // already tracked
    const lsig = groupSignature(lg);

    const existing = lsig ? savedBySig.get(lsig) : null;
    if (existing) {
      // A saved group with this identity already exists.
      if (!existing.active && existing.openWindowId == null) {
        // It was closed/inactive — the user just re-opened it natively. Re-link.
        existing.chromeGroupId = lg.chromeGroupId;
        existing.active = true;
        existing.title = lg.title || existing.title;
        existing.color = lg.color || existing.color;
        existing.tabs = lg.tabs;
        existing.tabCount = lg.tabs.length;
        existing.tabsLoaded = true;
        mappedChromeIds.add(lg.chromeGroupId);
      }
      continue; // already represented — never duplicate
    }

    if (lsig && deleted.has(lsig)) continue;                 // user deleted it
    if (lsig && capturedSigs.has(lsig)) continue;            // dedupe within this pass

    // Brand-new native group → capture it as an active saved group.
    const captured = normalizeGroup({
      uid: uid(),
      title: lg.title || "",
      color: lg.color || "grey",
      tabs: lg.tabs,
      tabCount: lg.tabs.length,
      tabsLoaded: true,
      active: true,
      chromeGroupId: lg.chromeGroupId,
      openWindowId: null,
    });
    groups.push(captured);
    mappedChromeIds.add(lg.chromeGroupId);
    if (lsig) { savedBySig.set(lsig, captured); capturedSigs.add(lsig); }
  }

  // Only persist + broadcast if something actually changed (avoids spurious
  // file-backup triggers every time any tab event fires).
  if (sig(groups) !== oldSig) {
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

// Read saved tab groups from the chosen profile(s) via the native host WITHOUT
// saving anything. Resolves { ok, data } so callers can either import directly
// or show the user a picker first.
function _nativeExtract(profileDirs = null) {
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
      (msg) => {
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
        finish({ ok: true, data });
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

async function importFromChrome(profileDirs = null) {
  const res = await _nativeExtract(profileDirs);
  if (!res.ok) return { ok: false, error: res.error };
  const deleted = await getDeletedKeys();
  const all = res.data?.savedGroups || [];
  const groups = all.filter((g) => !deleted.has(groupSignature(g)));
  const r = await importStore({ ...res.data, savedGroups: groups });
  return { ok: true, added: r.added, total: all.length };
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
  // If the SW was restarted from idle, _awRestore may still be in progress.
  // Wait for it so _activeWindows is populated before we read it.
  await _swReady;

  const tracked = _activeWindows.get(windowId);
  _activeWindows.delete(windowId);
  _awPersist();

  const store = await getStore();
  let changed = false;
  for (const g of store.savedGroups) {
    if (g.openWindowId !== windowId) continue;
    if (tracked?.tabs.length) {
      // Normal path: in-memory tracking was intact.
      g.tabs = tracked.tabs.map(({ url, title }) => ({ url, title }));
      g.tabCount = g.tabs.length;
      g.tabsLoaded = true;
    }
    // If tracked is empty (SW was idle and session restore had no entry):
    // g.tabs was already written on every individual tab-close (Fix 3 below),
    // so we keep the existing storage value — just flip the active flags.
    g.active = false;
    g.openWindowId = null;
    changed = true;
  }
  if (changed) await setStore({ savedGroups: store.savedGroups });
});

chrome.tabGroups.onCreated.addListener(scheduleReconcile);
chrome.tabGroups.onUpdated.addListener(scheduleReconcile);
chrome.tabGroups.onRemoved.addListener(scheduleReconcile);
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) {
    // Individual tab close while the window stays open.
    // Write the FULL updated tab list to storage immediately — do not just
    // update tabCount. This ensures the correct list survives even if the
    // SW goes idle before the window is closed (Fix for "deleted tabs reappear").
    await _swReady;
    for (const data of _activeWindows.values()) {
      const idx = data.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) {
        data.tabs.splice(idx, 1);
        _awPersist();
        const store = await getStore();
        const g = store.savedGroups.find(sg => sg.uid === data.groupUid);
        if (g) {
          g.tabs = data.tabs.map(({ url, title }) => ({ url, title }));
          g.tabCount = g.tabs.length;
          g.tabsLoaded = true;
          await setStore({ savedGroups: store.savedGroups });
        }
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
    if (g) {
      g.tabs = data.tabs.map(({ url, title }) => ({ url, title }));
      g.tabCount = g.tabs.length;
      g.tabsLoaded = true;
      await setStore({ savedGroups: store.savedGroups });
    }
  }
  scheduleReconcile();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Keep tracking map current when a tab navigates or its title changes.
  if (info.url || info.title) {
    let changedData = null;
    for (const data of _activeWindows.values()) {
      const tracked = data.tabs.find(t => t.id === tabId);
      if (tracked) {
        if (info.url) tracked.url = _realUrl(info.url);
        if (info.title) tracked.title = info.title;
        changedData = data;
        break;
      } else if (info.url && !info.url.startsWith("chrome://") && !_isSuspended(info.url)
                 && _activeWindows.has(tab.windowId)) {
        const d = _activeWindows.get(tab.windowId);
        d.tabs.push({ id: tabId, url: _realUrl(info.url), title: info.title || tab.title || "" });
        changedData = d;
        break;
      }
    }
    if (changedData) {
      _awPersist();
      // Write the full tab list immediately so navigation changes survive SW idle.
      try {
        const store = await getStore();
        const g = store.savedGroups.find(sg => sg.uid === changedData.groupUid);
        if (g) {
          g.tabs = changedData.tabs.map(({ url, title }) => ({ url, title }));
          g.tabCount = g.tabs.length;
          g.tabsLoaded = true;
          await setStore({ savedGroups: store.savedGroups });
        }
      } catch (_) {}
    }
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

  // Read groups from the chosen profile(s) WITHOUT saving — lets the side panel
  // show a picker so the user imports only the groups they actually want
  // (Chrome's sync DB holds every group from all their devices/accounts).
  async extractChromeGroups({ profileDirs } = {}) {
    const res = await _nativeExtract(profileDirs || null);
    if (!res.ok) return { ok: false, error: res.error };
    // Hide groups the user previously deleted so they don't keep coming back.
    const deleted = await getDeletedKeys();
    const all = res.data?.savedGroups || [];
    const filtered = all.filter((g) => !deleted.has(groupSignature(g)));
    return {
      ok: true,
      savedGroups: filtered,
      folders: res.data?.folders || [],
      hidden: all.length - filtered.length,
    };
  },

  async clearImportHistory() {
    await chrome.storage.local.remove(DELETED_KEYS);
    return { ok: true };
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

    const OPEN_BATCH = 25; // tabs per burst — keeps Chrome's tab scheduler from spiking

    if (freeMode) {
      // ── FREE MODE: own window, no Chrome tab group ──────────────────────────
      // Open first tab to create the window, then add the rest in small batches
      // so Chrome doesn't try to load/layout 400 tabs simultaneously.
      const [firstUrl, ...restUrls] = urls;
      const win = await chrome.windows.create({ url: firstUrl, focused: true });
      for (let i = 0; i < restUrls.length; i += OPEN_BATCH) {
        const batch = restUrls.slice(i, i + OPEN_BATCH);
        for (const url of batch) {
          await chrome.tabs.create({ url, windowId: win.id, active: false });
        }
        if (i + OPEN_BATCH < restUrls.length) {
          await new Promise(r => setTimeout(r, 80));
        }
      }
      group.active = true;
      group.openWindowId = win.id;
      group.chromeGroupId = null;

      // Seed the tracking map so tab changes (closes, navigations) are captured.
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
    for (let i = 0; i < urls.length; i++) {
      const created = await chrome.tabs.create({ url: urls[i], windowId: window.id, active: false });
      tabIds.push(created.id);
      if ((i + 1) % OPEN_BATCH === 0 && i + 1 < urls.length) {
        await new Promise(r => setTimeout(r, 80));
      }
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
    const removed = store.savedGroups.find((g) => g.uid === groupUid);
    const savedGroups = store.savedGroups.filter((g) => g.uid !== groupUid);
    if (removed) await addDeletedKeys([removed]); // remember it so import won't re-add it
    await setStore({ savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true };
  },

  async deduplicateGroupTabs({ groupUid }) {
    const store = await getStore();
    const group = buildIndexes(store).groupsByUid.get(groupUid);
    if (!group) return { ok: false };
    const tabs = group.tabs || [];
    const removeIndices = findTabDuplicateIndices(tabs);
    if (!removeIndices.length) return { ok: true, removed: 0, kept: tabs.length };
    removeIndices.forEach(i => tabs.splice(i, 1));
    group.tabCount = tabs.length;
    await setStore({ savedGroups: store.savedGroups });
    broadcast({ type: "STORE_UPDATED" });
    return { ok: true, removed: removeIndices.length, kept: tabs.length };
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
    await removeDeletedKeys([group]); // undo: clear its tombstone
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
      await removeDeletedKeys(groups); // undo: clear their tombstones
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
    const removed = store.savedGroups.filter((g) => toDelete.has(g.uid));
    const savedGroups = store.savedGroups.filter((g) => !toDelete.has(g.uid));
    if (removed.length) await addDeletedKeys(removed); // remember them so import won't re-add
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

  // Pages call this on load to decide whether to OFFER a data recovery.
  async getRecoveryStatus() {
    return getRecoveryStatus();
  },

  // Pages call this ONLY after the user explicitly clicks Restore. Merge-only.
  async applyRecovery(msg) {
    return applyRecovery(msg || {});
  },
};

// On startup, the extension does the BARE MINIMUM and NEVER pulls in groups:
// 1. _awRestore — rebuild in-memory tracking of windows this extension opened
//                 (from session storage); touches no saved groups.
// 2. reconcile  — flip active/inactive to match what's really open. It does NOT
//                 capture, import, restore, or delete anything.
//
// There is intentionally NO automatic restore of any kind. The old startup
// auto-restored a machine-shared file backup whenever local looked empty, which
// pulled another profile/account's data in and overwrote this profile's groups.
// Recovery is now strictly opt-in: pages call getRecoveryStatus and OFFER it;
// applyRecovery runs only on an explicit click and merges (never overwrites).
// _swReady resolves once _awRestore + initial reconcile have finished.
// Every event handler that reads _activeWindows awaits this so it never
// races against the async restore when the SW was restarted from idle.
const _swReady = _awRestore().then(() => reconcile());

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
