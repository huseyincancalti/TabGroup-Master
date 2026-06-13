<div align="center">

# TabGroup Master 🚀

### Your Chrome tab groups — organized, backed up, and yours.

**Turn Chrome's flat tab-group strip into a full-screen, nested workspace.**
Save groups, file them into folders, restore them with almost zero RAM, and back everything up — all on your machine, nothing in the cloud.

`Manifest V3` · `Chrome · Edge · Brave · Vivaldi` · `v1.0.0` · `No account, no tracking`

</div>

---

## 😖 The problem

Chrome's tab groups are great — until you have forty of them. They live in a single horizontal strip, "saved groups" quietly clutter your bookmarks bar, and the moment you close a window the layout is gone. There's no folder structure, no real backup, no way to see everything at once.

## ✨ The fix

TabGroup Master gives your groups a real home: a **tree of folders** you can drag groups into, a **side panel** for daily use, and a **full dashboard** for organizing — plus three independent backup layers so your work never disappears.

---

## 🔥 What you get

- **🗂️ Nested folder workspace** — Drag groups into unlimited nested folders. Smooth, instant, VS-Code-style.
- **🪟 Free Mode (default)** — Saved groups open in their *own window*, completely outside Chrome's native group system. Your bookmarks bar stays spotless.
- **💤 Frozen tabs (default)** — Reopen a 100-tab group and it costs almost no memory. Each tab is a lightweight placeholder that loads the real page the instant you click it.
- **⬇️ One-click import from Chrome** — Pull every *saved/closed* tab group straight out of your browser, per profile, with an explicit picker. Accounts are never mixed.
- **💾 One shortcut to save** — `Ctrl+Shift+G` snapshots the current window as a group. While it stays open, changes keep tracking automatically.
- **🧹 Cleanup tools** — Find unnamed/empty groups and merge duplicates, all with one-click Undo.
- **🔎 Smart search** — Searches titles *and* tab URLs, accent- and case-insensitive (handles Turkish `ç-c`, `ı-i`, `ş-s`), with live highlighting.
- **🛟 Triple backup** — Local off-profile file backup (survives profile resets) + cloud sync copy + portable JSON export.

---

## 🚀 Install in 60 seconds

1. **Download** — grab the latest [**Release**](https://github.com/huseyincancalti/TabGroup-Master/releases) and unzip it (or **Code → Download ZIP**).
2. Open `chrome://extensions/` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. Click the toolbar icon — the side panel opens. **That's it.** No `.exe`, no account, no setup.

### Optional: enable one-click import & file backup

This unlocks reading your *closed/saved* groups and the off-profile backup. It needs **Python 3** and runs once — no admin rights.

| Your OS | Run once |
|---|---|
| 🪟 Windows | `NativeHost\install.bat` |
| 🍎 macOS | `NativeHost/install.command` |
| 🐧 Linux | `NativeHost/install.sh` |

Then fully restart your browser and press **Import from Chrome**.

> **No Python?** No problem. In the Dashboard → **Settings → Import**, point the extension at a copy of your profile's `Sync Data/LevelDB` folder — it's parsed entirely inside the browser, no install at all.

---

## 🧭 How you'll use it

**Side panel** (the daily driver) — see active groups, open/close saved ones, search, and quick-capture the current window.

**Dashboard** (the full tab, click *Open Dashboard*) —
- **Overview** — live stats at a glance.
- **Workspace** — your folder tree. Drag groups in and out, rename inline, nest freely.
- **Cleanup** — clear out clutter and merge duplicates before you organize.
- **Settings** — import, backup/restore, behaviour toggles, and connection diagnostics.

A typical first run: *Import from Chrome → Cleanup the junk → drag the keepers into folders → reopen any group from the side panel whenever you need it.*

---

<details>
<summary><h2>🛠️ Under the hood — for the curious</h2></summary>

### Why it's built this way

**Manifest V3, zero servers.** Everything is local. Your data lives in `chrome.storage.local`; the optional native host is a small Python script that only reads the profile folders *you* select. There is no backend, no telemetry, no account.

**Free Mode exists on purpose.** Chrome's "saved tab groups" feature writes entries onto your bookmarks bar and into Chrome's own sync. For people who want their groups managed *here* and nowhere else, Free Mode opens each group in its own window and never touches Chrome's group system. Nothing leaks.

**Frozen tabs are the RAM trick.** Restoring a big group as live tabs can eat gigabytes. Instead, each tab opens as a tiny local placeholder page holding the real URL; the page navigates to the real site only when you actually view it. A hundred tabs, almost no memory — until you need them.

**The import is real reverse-engineering.** Chrome stores closed/saved groups in a LevelDB database using an internal protobuf format (`saved_tab_group-dt-`). TabGroup Master ships **two independent readers** for it: a Python native host, and a *pure-JavaScript* LevelDB + Snappy + protobuf parser that runs in the browser with no dependencies — so even users without Python can import.

**Three backup layers, by design.** A local file backup written *outside* the browser profile (so a profile reset can't wipe it), a compact mirror in `chrome.storage.sync` (survives sign-outs), and a portable JSON export you own. Large backups are chunked under Chrome's 1 MB native-messaging limit so nothing silently fails.

**Security first.** All user-supplied text (group names, tab titles, imported URLs) is HTML-escaped before rendering, and only `http(s)/ftp/mailto` links are ever made clickable — so a malicious imported tab can't run script inside the extension.

### Project layout

```
manifest.json        — MV3 config, commands, icons
background.js         — service worker: store, reconcile, backups, native bridge
sidepanel.*           — the daily-use side panel
dashboard.*           — the full workspace / cleanup / settings UI
suspended.*           — the frozen-tab placeholder page
lib/chrome_import.js  — pure-JS LevelDB/Snappy/protobuf importer
NativeHost/           — optional Python host (import + off-profile file backup)
```

</details>

---

## 🔒 Privacy

100% local. No analytics, no remote servers, no account. The optional native host only ever reads the profile folders you explicitly choose, and writes backups to your own machine.

---

## 📬 Support

Found a bug or have an idea? Open an [**Issue**](https://github.com/huseyincancalti/TabGroup-Master/issues) or reach out by email.

- **Developer:** [Hüseyin Can Çaltı](https://github.com/huseyincancalti)
- **Email:** [hsyncalti2@gmail.com](mailto:hsyncalti2@gmail.com)

---

<div align="center">

*If TabGroup Master saves your tabs (and your sanity), drop a ⭐ — it genuinely helps.*

<br>

**Crafted with 🖤 by [karakedidub.com](https://karakedidub.com)**

</div>
