/* ───────────────────────────────────────────────────────────────────────────
 * TabGroup Master — Pure-JS Chrome saved-tab-group importer.
 *
 * Reads Chrome/Edge/Brave's "Sync Data/LevelDB" directly in the browser using
 * the File System Access API. No native host, no Python, no installer.
 *
 * Pipeline:  pick folder  ->  read *.ldb / *.log  ->  LevelDB parse
 *            ->  Snappy decompress  ->  protobuf decode  ->  saved groups
 *
 * Exposes: window.ChromeGroupImport.pickAndImport() -> {savedGroups, folders}
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // ── Snappy raw block decompression ─────────────────────────────────────────
  function snappyDecompress(input) {
    let pos = 0, length = 0, shift = 0, b;
    do { b = input[pos++]; length |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const out = new Uint8Array(length);
    let o = 0;
    while (pos < input.length) {
      const tag = input[pos++];
      const type = tag & 0x3;
      if (type === 0) {
        let litLen = (tag >> 2) + 1;
        if (litLen > 60) {
          const extra = litLen - 60;
          litLen = 0;
          for (let i = 0; i < extra; i++) litLen |= input[pos++] << (8 * i);
          litLen = (litLen >>> 0) + 1;
        }
        out.set(input.subarray(pos, pos + litLen), o);
        pos += litLen; o += litLen;
      } else {
        let copyLen, offset;
        if (type === 1) {
          copyLen = ((tag >> 2) & 0x7) + 4;
          offset = ((tag >> 5) << 8) | input[pos++];
        } else if (type === 2) {
          copyLen = (tag >> 2) + 1;
          offset = input[pos] | (input[pos + 1] << 8); pos += 2;
        } else {
          copyLen = (tag >> 2) + 1;
          offset = (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)) >>> 0;
          pos += 4;
        }
        let from = o - offset;
        for (let i = 0; i < copyLen; i++) out[o++] = out[from++];
      }
    }
    return out;
  }

  // ── Varint (multiplication-based so it survives > 32-bit shifts) ────────────
  function readVarint(buf, pos) {
    let result = 0, shift = 0, b;
    do { b = buf[pos++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    return [result, pos];
  }

  function latin1(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function concatBytes(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const r = new Uint8Array(total);
    let o = 0;
    for (const a of arrays) { r.set(a, o); o += a.length; }
    return r;
  }

  // ── LevelDB block parsing ───────────────────────────────────────────────────
  function parseBlock(block) {
    const n = block.length;
    if (n < 4) return [];
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const numRestarts = dv.getUint32(n - 4, true);
    let restartStart = n - 4 - numRestarts * 4;
    if (restartStart < 0) restartStart = n - 4;
    let pos = 0;
    let lastKey = new Uint8Array(0);
    const entries = [];
    while (pos < restartStart) {
      let shared, nonShared, valueLen;
      [shared, pos] = readVarint(block, pos);
      [nonShared, pos] = readVarint(block, pos);
      [valueLen, pos] = readVarint(block, pos);
      const key = new Uint8Array(shared + nonShared);
      key.set(lastKey.subarray(0, shared), 0);
      key.set(block.subarray(pos, pos + nonShared), shared);
      pos += nonShared;
      const value = block.subarray(pos, pos + valueLen);
      pos += valueLen;
      lastKey = key;
      entries.push([key, value]);
    }
    return entries;
  }

  function loadBlock(data, offset, size) {
    const block = data.subarray(offset, offset + size);
    const comp = data[offset + size];
    if (comp === 1) return snappyDecompress(block);
    if (comp === 0) return block;
    return null;
  }

  const LDB_MAGIC_LO = 0x8b80fb57; // low  32 bits of 0xDB4775248B80FB57
  const LDB_MAGIC_HI = 0xdb477524; // high 32 bits

  function readLdb(data) {
    if (data.length < 48) return [];
    const footer = data.subarray(data.length - 48);
    const fdv = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    if (fdv.getUint32(40, true) !== LDB_MAGIC_LO || fdv.getUint32(44, true) !== LDB_MAGIC_HI) return [];
    let pos = 0, _v, indexOff, indexSize;
    [_v, pos] = readVarint(footer, pos);   // metaindex offset
    [_v, pos] = readVarint(footer, pos);   // metaindex size
    [indexOff, pos] = readVarint(footer, pos);
    [indexSize, pos] = readVarint(footer, pos);
    const indexBlock = loadBlock(data, indexOff, indexSize);
    if (!indexBlock) return [];
    const out = [];
    for (const [, handle] of parseBlock(indexBlock)) {
      if (handle.length < 2) continue;
      try {
        let hp = 0, blkOff, blkSize;
        [blkOff, hp] = readVarint(handle, hp);
        [blkSize, hp] = readVarint(handle, hp);
        if (blkOff + blkSize + 1 > data.length) continue;
        const block = loadBlock(data, blkOff, blkSize);
        if (!block) continue;
        for (const [key, value] of parseBlock(block)) {
          if (key.length < 8) continue;
          const tdv = new DataView(key.buffer, key.byteOffset + key.length - 8, 8);
          const lo = tdv.getUint32(0, true), hi = tdv.getUint32(4, true);
          const seq = Math.floor((hi * 0x100000000 + lo) / 256);
          const deleted = (lo & 0xff) === 0;
          out.push([key.subarray(0, key.length - 8), deleted ? null : value, seq]);
        }
      } catch (_) { /* skip bad block */ }
    }
    return out;
  }

  function readLog(data) {
    const records = [];
    let pos = 0, pending = [];
    const BLOCK = 32768;
    while (pos + 7 <= data.length) {
      const blockRemaining = BLOCK - (pos % BLOCK);
      if (blockRemaining < 7) { pos += blockRemaining; continue; }
      const dv = new DataView(data.buffer, data.byteOffset + pos + 4, 2);
      const length = dv.getUint16(0, true);
      const rectype = data[pos + 6];
      const payload = data.subarray(pos + 7, pos + 7 + length);
      pos += 7 + length;
      if (rectype === 1) records.push(payload);
      else if (rectype === 2) pending = [payload];
      else if (rectype === 3) pending.push(payload);
      else if (rectype === 4) { pending.push(payload); records.push(concatBytes(pending)); pending = []; }
    }
    const out = [];
    for (const batch of records) {
      if (batch.length < 12) continue;
      const bdv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
      let seq = bdv.getUint32(0, true) + bdv.getUint32(4, true) * 0x100000000;
      let bp = 12;
      try {
        while (bp < batch.length) {
          const t = batch[bp]; bp += 1;
          let klen; [klen, bp] = readVarint(batch, bp);
          const key = batch.subarray(bp, bp + klen); bp += klen;
          if (t === 1) {
            let vlen; [vlen, bp] = readVarint(batch, bp);
            out.push([key, batch.subarray(bp, bp + vlen), seq]); bp += vlen;
          } else if (t === 0) {
            out.push([key, null, seq]);
          } else break;
          seq += 1;
        }
      } catch (_) { /* skip bad batch */ }
    }
    return out;
  }

  function mergeEntities(all) {
    const best = new Map();
    for (const [key, value, seq] of all) {
      const k = latin1(key);
      const ex = best.get(k);
      if (!ex || seq >= ex.seq) best.set(k, { key, value, seq });
    }
    const result = [];
    for (const { key, value } of best.values()) if (value !== null) result.push([key, value]);
    return result;
  }

  // ── Protobuf-ish decode (mirror of the Python native host) ──────────────────
  const _utf8 = new TextDecoder("utf-8", { fatal: true });

  function looksLikeMessage(raw) {
    try {
      let pos = 0;
      while (pos < raw.length) {
        let tag; [tag, pos] = readVarint(raw, pos);
        const field = Math.floor(tag / 8), wire = tag & 7;
        if (field === 0) return false;
        if (wire === 2) { let len; [len, pos] = readVarint(raw, pos); pos += len; }
        else if (wire === 0) { let _; [_, pos] = readVarint(raw, pos); }
        else if (wire === 5) pos += 4;
        else if (wire === 1) pos += 8;
        else return false;
      }
      return pos === raw.length;
    } catch (_) { return false; }
  }

  function decodeMessage(buf, depth) {
    depth = depth || 0;
    const fields = {};
    let pos = 0;
    while (pos < buf.length) {
      let tag; [tag, pos] = readVarint(buf, pos);
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0) {
        let value; [value, pos] = readVarint(buf, pos);
        if (!(field in fields)) fields[field] = value;
      } else if (wire === 2) {
        let len; [len, pos] = readVarint(buf, pos);
        const raw = buf.subarray(pos, pos + len); pos += len;
        if (field in fields) continue;
        if (depth < 5 && len >= 2 && looksLikeMessage(raw)) {
          fields[field] = decodeMessage(raw, depth + 1);
        } else {
          try { fields[field] = _utf8.decode(raw); }
          catch (_) { fields[field] = raw; }
        }
      } else if (wire === 5) pos += 4;
      else if (wire === 1) pos += 8;
      else break;
    }
    return fields;
  }

  // ── Assemble saved groups from decoded entities ─────────────────────────────
  const COLOR_NAMES = {
    0: "grey", 1: "grey", 2: "blue", 3: "red", 4: "yellow",
    5: "green", 6: "pink", 7: "purple", 8: "cyan", 9: "orange",
  };
  const MARKER = "saved_tab_group-dt-";

  function extractSavedGroups(entries) {
    const groups = {};
    const tabs = [];
    for (const [key, value] of entries) {
      if (!latin1(key).includes(MARKER)) continue;
      let spec;
      try { spec = decodeMessage(value)[2]; } catch (_) { continue; }
      if (!spec || typeof spec !== "object") continue;
      const guid = spec[1], group = spec[4], tab = spec[5];
      if (group && typeof group === "object") {
        if (typeof guid === "string") {
          const colorId = typeof group[3] === "number" ? group[3] : 0;
          groups[guid] = {
            title: typeof group[2] === "string" ? group[2] : "",
            color: COLOR_NAMES[colorId] || "grey",
          };
        }
      } else if (tab && typeof tab === "object") {
        const url = tab[3], title = tab[4];
        if (typeof url === "string" && url && !url.startsWith("chrome://")) {
          tabs.push({
            group_guid: tab[1],
            position: typeof tab[2] === "number" ? tab[2] : 0,
            url,
            title: typeof title === "string" ? title : url,
          });
        }
      }
    }

    const byGroup = {};
    for (const t of tabs) (byGroup[t.group_guid] = byGroup[t.group_guid] || []).push(t);

    const savedGroups = [];
    for (const guid of Object.keys(groups)) {
      const info = groups[guid];
      const gtabs = (byGroup[guid] || []).slice().sort((a, b) => a.position - b.position);
      savedGroups.push({
        title: info.title,
        color: info.color,
        tabs: gtabs.map((t) => ({ url: t.url, title: t.title })),
        tabCount: gtabs.length,
        tabsLoaded: true,
        active: false,
        chromeGroupId: null,
        folderId: null,
      });
    }
    savedGroups.sort((a, b) => (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase()));
    return { savedGroups, folders: [] };
  }

  const DESCEND_RE = /^(Default|Profile |Snapshots|Sync Data|LevelDB)/;

  // ── Walk a directory handle, collecting every LevelDB .ldb / .log file ──────
  async function collectLevelDbFiles(dirHandle, acc, depth, isRoot) {
    acc = acc || []; depth = depth || 0;
    if (depth > 8) return acc;
    const collectHere = isRoot || dirHandle.name === "LevelDB";
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file") {
        if (collectHere && (name.endsWith(".ldb") || name.endsWith(".log"))) {
          try {
            const file = await handle.getFile();
            acc.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
          } catch (_) { /* locked / unreadable — skip */ }
        }
      } else if (handle.kind === "directory") {
        // Prune so dropping a huge "User Data" folder stays fast.
        if (depth === 0 || DESCEND_RE.test(name)) {
          await collectLevelDbFiles(handle, acc, depth + 1, false);
        }
      }
    }
    return acc;
  }

  // ── webkitGetAsEntry fallback (older drag-drop API) ─────────────────────────
  function _entryFile(fileEntry) {
    return new Promise((res, rej) => fileEntry.file(res, rej));
  }
  function _readDir(dirEntry) {
    const reader = dirEntry.createReader();
    return new Promise((res) => {
      const out = [];
      const step = () => reader.readEntries(
        (batch) => { if (!batch.length) res(out); else { out.push.apply(out, batch); step(); } },
        () => res(out)
      );
      step();
    });
  }
  async function _pushEntryFile(entry, acc) {
    try {
      const f = await _entryFile(entry);
      acc.push({ name: entry.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch (_) { /* skip */ }
  }
  async function collectFromEntry(entry, acc, depth, isRoot) {
    acc = acc || []; depth = depth || 0;
    if (depth > 8) return acc;
    if (entry.isFile) {
      if (entry.name.endsWith(".ldb") || entry.name.endsWith(".log")) await _pushEntryFile(entry, acc);
      return acc;
    }
    const collectHere = isRoot || entry.name === "LevelDB";
    for (const child of await _readDir(entry)) {
      if (child.isFile) {
        if (collectHere && (child.name.endsWith(".ldb") || child.name.endsWith(".log"))) await _pushEntryFile(child, acc);
      } else if (child.isDirectory && (depth === 0 || DESCEND_RE.test(child.name))) {
        await collectFromEntry(child, acc, depth + 1, false);
      }
    }
    return acc;
  }

  // ── Parse a set of {name, bytes} LevelDB files into saved groups ────────────
  function parseByteFiles(files) {
    const all = [];
    for (const f of files) {
      try {
        if (f.name.endsWith(".ldb")) Array.prototype.push.apply(all, readLdb(f.bytes));
        else if (f.name.endsWith(".log")) Array.prototype.push.apply(all, readLog(f.bytes));
      } catch (_) { /* skip bad file */ }
    }
    return extractSavedGroups(mergeEntities(all));
  }

  // ── Entry point A: <input type="file" webkitdirectory> (bypasses the File ───
  // System Access "system files" blocklist, so it reads the real profile folder).
  async function importFromFileList(fileList) {
    const list = Array.from(fileList || []);
    const isDb = (f) => f.name.endsWith(".ldb") || f.name.endsWith(".log");
    // Prefer files that live in a "LevelDB" folder; fall back to any db file.
    let pool = list.filter((f) => isDb(f) && /(^|\/)LevelDB\//.test(f.webkitRelativePath || ""));
    if (!pool.length) pool = list.filter(isDb);
    if (!pool.length) {
      throw new Error(
        'No tab-group database files (.ldb / .log) in that folder. ' +
        'Pick the "LevelDB" folder (or the "Sync Data" / profile folder above it).'
      );
    }
    const files = [];
    for (const file of pool) {
      try { files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
      catch (_) { /* unreadable — skip */ }
    }
    return parseByteFiles(files);
  }

  // ── Entry point B: drag-and-drop ──────────────────────────────────────────────
  // IMPORTANT: Chrome OS-level-blocks ALL JS file APIs (including webkitGetAsEntry
  // and getAsFileSystemHandle) when the dragged item is inside Chrome's own User
  // Data directory.  The only reliable workaround is to copy the LevelDB folder to
  // a non-system location (Desktop) first and then drag THAT copy here.
  //
  // We deliberately do NOT fall back to getAsFileSystemHandle() here because that
  // call triggers Chrome's native "this folder can't be opened" error dialog even
  // when it would ultimately return nothing — a confusing UX.
  async function importFromDataTransfer(dataTransfer) {
    // DataTransfer is only valid during the drop event — collect SYNCHRONOUSLY.
    const entries = [];
    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry) {
        const e = item.webkitGetAsEntry();
        if (e) entries.push(e);
      }
    }

    if (!entries.length) {
      throw new Error(
        "BLOCKED — Chrome protects its own profile folder from browser access. " +
        "Copy the LevelDB folder to your Desktop first, then drag it here."
      );
    }

    const byteFiles = [];
    for (const e of entries) await collectFromEntry(e, byteFiles, 0, true);

    if (!byteFiles.length) {
      throw new Error(
        "No LevelDB files (.ldb / .log) found in what you dropped. " +
        "Make sure you drop the \"LevelDB\" folder (or a profile / Sync Data folder that contains it). " +
        "If you dragged Chrome's User Data folder directly, Chrome blocks it — copy LevelDB to Desktop first."
      );
    }
    return parseByteFiles(byteFiles);
  }

  // ── Entry point C: File System Access folder picker (blocked for profile dirs) ─
  async function pickAndImport() {
    if (!window.showDirectoryPicker) {
      throw new Error("This browser does not support folder import. Please update it.");
    }
    const dir = await window.showDirectoryPicker({ id: "tgm-profile", mode: "read" });
    const files = await collectLevelDbFiles(dir, [], 0, true);
    if (!files.length) {
      throw new Error('No tab-group database found there. Pick the "LevelDB" folder inside "Sync Data".');
    }
    return parseByteFiles(files);
  }

  const api = { importFromFileList, importFromDataTransfer, pickAndImport };
  if (typeof window !== "undefined") window.ChromeGroupImport = api;
  // Node-only export so the parser can be unit-tested without a browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.assign({}, api, {
      _test: { snappyDecompress, readLdb, readLog, mergeEntities, extractSavedGroups, decodeMessage, collectLevelDbFiles, parseByteFiles },
    });
  }
})();
