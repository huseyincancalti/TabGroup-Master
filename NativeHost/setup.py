# -*- coding: utf-8 -*-
"""
TabGroup Master -- Native host installer (cross-platform, no admin required).

Registers the optional native messaging host so the extension can read your
*closed/saved* tab groups. Works on Windows, macOS and Linux, and for every
Chromium browser found (Chrome, Edge, Brave, Vivaldi, Chromium).

The core extension works WITHOUT this -- it's only needed for the one-time
bulk import of groups that aren't currently open in the browser.
"""

import base64
import hashlib
import json
import os
import stat
import sys

# UTF-8 console so non-ASCII profile names never crash the installer.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST_NAME    = "com.tabgroup.master"
FALLBACK_ID  = "djcabdgkkjbombggiidahbbmnjopgoeb"

here    = os.path.dirname(os.path.abspath(__file__))   # .../NativeHost/
ext_dir = os.path.dirname(here)                         # .../TabGroup-Master/


# ── Extension ID (derived from manifest "key", identical on every browser) ─────
def extension_id() -> str:
    try:
        with open(os.path.join(ext_dir, "manifest.json"), "r", encoding="utf-8") as f:
            key = json.load(f).get("key", "")
        if not key:
            return FALLBACK_ID
        der = base64.b64decode(key)
        h = hashlib.sha256(der).digest()
        a = "abcdefghijklmnop"
        return "".join(a[(b >> 4) & 0xf] + a[b & 0xf] for b in h[:16])
    except Exception:
        return FALLBACK_ID


# ── Launcher script that the browser executes to start the host ────────────────
def write_launcher() -> str:
    importer = os.path.join(here, "importer.py")
    py = sys.executable
    if os.name == "nt":
        path = os.path.join(here, "run_host.bat")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f'@echo off\r\n"{py}" "{importer}"\r\n')
    else:
        path = os.path.join(here, "run_host.sh")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{py}" "{importer}"\n')
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


# ── Where each browser looks for native messaging host manifests ───────────────
def windows_registry_subkeys():
    # HKEY_CURRENT_USER -> no admin needed.
    return [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        r"Software\Chromium\NativeMessagingHosts",
        r"Software\Vivaldi\NativeMessagingHosts",
    ]


def posix_browser_dirs():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
        return {
            "Chrome":   os.path.join(base, "Google", "Chrome"),
            "Edge":     os.path.join(base, "Microsoft Edge"),
            "Brave":    os.path.join(base, "BraveSoftware", "Brave-Browser"),
            "Vivaldi":  os.path.join(base, "Vivaldi"),
            "Chromium": os.path.join(base, "Chromium"),
        }
    # linux / *bsd
    base = os.path.join(home, ".config")
    return {
        "Chrome":   os.path.join(base, "google-chrome"),
        "Edge":     os.path.join(base, "microsoft-edge"),
        "Brave":    os.path.join(base, "BraveSoftware", "Brave-Browser"),
        "Vivaldi":  os.path.join(base, "vivaldi"),
        "Chromium": os.path.join(base, "chromium"),
    }


# ── Registration ───────────────────────────────────────────────────────────────
def register_windows(manifest_path: str):
    import winreg
    done = []
    for subkey in windows_registry_subkeys():
        try:
            k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, subkey + "\\" + HOST_NAME)
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifest_path)
            winreg.CloseKey(k)
            done.append(subkey.split("\\")[1])  # vendor name
        except Exception:
            pass
    return done


def register_posix(manifest: dict):
    done = []
    for label, browser_dir in posix_browser_dirs().items():
        # Register where the browser actually exists, plus always Chrome.
        if not os.path.isdir(browser_dir) and label != "Chrome":
            continue
        host_dir = os.path.join(browser_dir, "NativeMessagingHosts")
        try:
            os.makedirs(host_dir, exist_ok=True)
            with open(os.path.join(host_dir, HOST_NAME + ".json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
            done.append(label)
        except Exception:
            pass
    return done


# ═══════════════════════════════════════════════════════════════════════════════
def main():
    print("=" * 56)
    print("TabGroup Master -- Native host setup")
    print("=" * 56)

    ext_id   = extension_id()
    launcher = write_launcher()
    print(f"[OK]  Extension ID : {ext_id}")
    print(f"[OK]  Launcher     : {launcher}")

    manifest = {
        "name": HOST_NAME,
        "description": "TabGroup Master Native Host",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }

    if os.name == "nt":
        # On Windows the registry value points to a manifest file on disk.
        manifest_path = os.path.join(here, HOST_NAME + ".json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        done = register_windows(manifest_path)
    else:
        done = register_posix(manifest)

    if done:
        print(f"[OK]  Registered for: {', '.join(done)}")
    else:
        print("[WARN] No browser registration succeeded.")

    print()
    print("Done. Next steps:")
    print("  1. Fully quit and reopen your browser.")
    print("  2. Reload the extension once (extensions page -> Reload).")
    print("  3. Use 'Import from Chrome' inside TabGroup Master.")
    print("=" * 56)


if __name__ == "__main__":
    main()
