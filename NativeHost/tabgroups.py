import os
import sys
import glob
import json
import shutil
import tempfile
import time

import leveldb_reader as L


def _app_data_dir():
    """Per-OS app data directory, outside any browser profile (survives resets)."""
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", home), "TabGroupMaster")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "TabGroupMaster")
    return os.path.join(
        os.environ.get("XDG_DATA_HOME", os.path.join(home, ".local", "share")),
        "TabGroupMaster",
    )


# ── App-data file backup (outside the browser profile, survives resets) ────────
_BACKUP_DIR  = _app_data_dir()
_BACKUP_FILE = os.path.join(_BACKUP_DIR, "workspace_backup.json")


def save_backup(data: dict) -> bool:
    """Persist the full workspace to LOCALAPPDATA. Survives Chrome profile wipes."""
    try:
        os.makedirs(_BACKUP_DIR, exist_ok=True)
        tmp = _BACKUP_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, _BACKUP_FILE)   # atomic write
        return True
    except Exception:
        return False


def load_backup() -> dict | None:
    """Read workspace backup from LOCALAPPDATA. Returns None if not found."""
    try:
        with open(_BACKUP_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

COLOR_NAMES = {
    0: "grey", 1: "grey", 2: "blue", 3: "red", 4: "yellow",
    5: "green", 6: "pink", 7: "purple", 8: "cyan", 9: "orange",
}

ENTITY_KEY_MARKER = b"saved_tab_group-dt-"


def _varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def _looks_like_message(raw):
    try:
        pos = 0
        while pos < len(raw):
            tag, pos = _varint(raw, pos)
            field = tag >> 3
            wire = tag & 7
            if field == 0:
                return False
            if wire == 2:
                length, pos = _varint(raw, pos)
                pos += length
            elif wire == 0:
                _, pos = _varint(raw, pos)
            elif wire == 5:
                pos += 4
            elif wire == 1:
                pos += 8
            else:
                return False
        return pos == len(raw)
    except Exception:
        return False


def _decode(buf, depth=0):
    fields = {}
    pos = 0
    while pos < len(buf):
        tag, pos = _varint(buf, pos)
        field = tag >> 3
        wire = tag & 7
        if wire == 0:
            value, pos = _varint(buf, pos)
            fields.setdefault(field, value)
        elif wire == 2:
            length, pos = _varint(buf, pos)
            raw = buf[pos:pos + length]
            pos += length
            if depth < 5 and length >= 2 and _looks_like_message(raw):
                fields.setdefault(field, _decode(raw, depth + 1))
            else:
                try:
                    fields.setdefault(field, raw.decode("utf-8"))
                except UnicodeDecodeError:
                    fields.setdefault(field, raw)
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            break
    return fields


def _browser_user_data_dirs():
    """Every installed Chromium browser's 'User Data' root, across Windows/Mac/Linux."""
    home = os.path.expanduser("~")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        cand = [
            ("Chrome",   os.path.join(local, "Google", "Chrome", "User Data")),
            ("Edge",     os.path.join(local, "Microsoft", "Edge", "User Data")),
            ("Brave",    os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data")),
            ("Vivaldi",  os.path.join(local, "Vivaldi", "User Data")),
            ("Chromium", os.path.join(local, "Chromium", "User Data")),
        ]
    elif sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
        cand = [
            ("Chrome",   os.path.join(base, "Google", "Chrome")),
            ("Edge",     os.path.join(base, "Microsoft Edge")),
            ("Brave",    os.path.join(base, "BraveSoftware", "Brave-Browser")),
            ("Vivaldi",  os.path.join(base, "Vivaldi")),
            ("Chromium", os.path.join(base, "Chromium")),
        ]
    else:  # linux / *bsd
        base = os.path.join(home, ".config")
        cand = [
            ("Chrome",   os.path.join(base, "google-chrome")),
            ("Edge",     os.path.join(base, "microsoft-edge")),
            ("Brave",    os.path.join(base, "BraveSoftware", "Brave-Browser")),
            ("Vivaldi",  os.path.join(base, "vivaldi")),
            ("Chromium", os.path.join(base, "chromium")),
        ]
    return [(label, p) for (label, p) in cand if os.path.isdir(p)]


def list_profiles():
    """Metadata for every Chromium-browser profile that has a Sync Data/LevelDB dir."""
    profiles = []
    for label, user_data in _browser_user_data_dirs():
        names = ["Default"] + [
            os.path.basename(p) for p in glob.glob(os.path.join(user_data, "Profile *"))
        ]
        for name in names:
            leveldb = os.path.join(user_data, name, "Sync Data", "LevelDB")
            if not os.path.isdir(leveldb):
                continue
            display_name = name
            email = ""
            try:
                prefs_path = os.path.join(user_data, name, "Preferences")
                with open(prefs_path, "r", encoding="utf-8", errors="ignore") as f:
                    prefs = json.load(f)
                acct_list = prefs.get("account_info", [])
                if isinstance(acct_list, list) and acct_list:
                    email = acct_list[0].get("email", "")
                pname = prefs.get("profile", {}).get("name", "")
                if pname:
                    display_name = pname
            except Exception:
                pass
            profiles.append({
                "dir": leveldb,
                "browser": label,
                "profileName": name,
                "displayName": f"{label} — {display_name}",
                "email": email,
            })
    return profiles


def _all_profile_dirs():
    """Every profile's LevelDB dir across all installed Chromium browsers."""
    dirs = []
    for _label, user_data in _browser_user_data_dirs():
        names = ["Default"] + [
            os.path.basename(p) for p in glob.glob(os.path.join(user_data, "Profile *"))
        ]
        for name in names:
            leveldb = os.path.join(user_data, name, "Sync Data", "LevelDB")
            if os.path.isdir(leveldb):
                dirs.append(leveldb)
    return dirs


def _read_entities(leveldb_dir):
    tmp = tempfile.mkdtemp(prefix="tgm_")
    try:
        for f in glob.glob(os.path.join(leveldb_dir, "*")):
            if os.path.isfile(f):
                try:
                    shutil.copy2(f, tmp)
                except OSError:
                    pass
        merged = L.read_all(tmp)
        return [v for k, v in merged.items() if ENTITY_KEY_MARKER in k and v]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def extract(profile_dirs=None):
    """Extract all saved tab groups.

    profile_dirs: list of absolute LevelDB directory paths to scan, or None to scan all.
    """
    if profile_dirs is not None:
        dirs = [d for d in profile_dirs if isinstance(d, str) and os.path.isdir(d)]
    else:
        dirs = _all_profile_dirs()

    if not dirs:
        return {"savedGroups": [], "folders": [], "error": "No Chromium browser profile found"}

    groups = {}
    tabs = []

    for leveldb_dir in dirs:
        for value in _read_entities(leveldb_dir):
            spec = _decode(value).get(2)
            if not isinstance(spec, dict):
                continue
            guid = spec.get(1)
            group = spec.get(4)
            tab = spec.get(5)
            if isinstance(group, dict):
                title = group.get(2)
                color_id = group.get(3, 0)
                if isinstance(guid, str):
                    groups[guid] = {
                        "title": title if isinstance(title, str) else "",
                        "color": COLOR_NAMES.get(color_id if isinstance(color_id, int) else 0, "grey"),
                    }
            elif isinstance(tab, dict):
                url = tab.get(3)
                title = tab.get(4)
                if isinstance(url, str) and url and not url.startswith("chrome://"):
                    tabs.append({
                        "group_guid": tab.get(1),
                        "position": tab.get(2, 0) if isinstance(tab.get(2), int) else 0,
                        "url": url,
                        "title": title if isinstance(title, str) else url,
                    })

    by_group = {}
    for tab in tabs:
        by_group.setdefault(tab["group_guid"], []).append(tab)

    saved_groups = []
    for guid, info in groups.items():
        group_tabs = sorted(by_group.get(guid, []), key=lambda t: t["position"])
        saved_groups.append({
            "title": info["title"],
            "color": info["color"],
            "tabs": [{"url": t["url"], "title": t["title"]} for t in group_tabs],
            "tabCount": len(group_tabs),
            "tabsLoaded": True,
            "active": False,
            "chromeGroupId": None,
            "folderId": None,
        })

    saved_groups.sort(key=lambda g: g["title"].lower())
    return {
        "app": "TabGroup Master",
        "version": "1.0.0",
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "savedGroups": saved_groups,
        "folders": [],
    }
