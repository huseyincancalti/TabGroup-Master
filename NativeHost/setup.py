# -*- coding: utf-8 -*-
"""
TabGroup Master -- One-click installer (ASCII-safe, works while Chrome is open)
"""

import base64
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import tempfile

try:
    import winreg
except ImportError:
    print("ERROR: Windows only.")
    sys.exit(1)

# Force UTF-8 output on Windows consoles so special chars don't crash
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HOST_NAME       = "com.tabgroup.master"
NATIVE_REG_KEY  = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
# Try HKLM (machine-wide, requires admin — install.bat now elevates).
# Chrome reads policies from both HKCU and HKLM; HKLM is more reliable.
POLICY_REG_KEY  = r"SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
ALLOWLIST_KEY   = r"SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist"
SCHED_TASK_NAME = "TabGroupMaster_NativeHost"

here    = os.path.dirname(os.path.abspath(__file__))   # .../NativeHost/
ext_dir = os.path.dirname(here)                         # .../TabGroup-Master/

# ── helpers ────────────────────────────────────────────────────────────────────

def ext_id_from_der(pub_key_der: bytes) -> str:
    h = hashlib.sha256(pub_key_der).digest()
    a = "abcdefghijklmnop"
    return "".join(a[(b >> 4) & 0xf] + a[b & 0xf] for b in h[:16])


def read_manifest_key_der() -> bytes | None:
    mfst = os.path.join(ext_dir, "manifest.json")
    try:
        with open(mfst, "r", encoding="utf-8") as f:
            data = json.load(f)
        k = data.get("key", "")
        return base64.b64decode(k) if k else None
    except Exception:
        return None


def find_chrome_exe() -> str | None:
    lapp = os.environ.get("LOCALAPPDATA", "")
    pf   = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    for p in [
        os.path.join(pf,   "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(lapp, "Google", "Chrome", "Application", "chrome.exe"),
    ]:
        if os.path.exists(p):
            return p
    return None


def parse_crx_pubkey(crx_path: str) -> bytes | None:
    """Extract SubjectPublicKeyInfo DER from a CRX2 file header."""
    try:
        with open(crx_path, "rb") as f:
            if f.read(4) != b"Cr24":
                return None
            struct.unpack("<I", f.read(4))        # version
            pk_len  = struct.unpack("<I", f.read(4))[0]
            struct.unpack("<I", f.read(4))        # sig_len
            return f.read(pk_len)
    except Exception:
        return None


def kill_chrome():
    """Terminate all chrome.exe processes so --pack-extension works cleanly."""
    try:
        subprocess.run(["taskkill", "/F", "/IM", "chrome.exe"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import time; time.sleep(1)
    except Exception:
        pass


def build_crx_with_chrome(chrome_exe: str, pem_path: str | None) -> str | None:
    """
    Pack the extension as .crx using Chrome.exe.
    Chrome MUST be closed for --pack-extension to work, so we kill it first,
    run the pack, then Chrome will be reopened by the user (or auto by policy).
    Returns path to the .crx on success, None on failure.
    """
    parent   = os.path.dirname(ext_dir)
    ext_name = os.path.basename(ext_dir)
    out_crx  = os.path.join(parent, ext_name + ".crx")
    out_pem  = os.path.join(parent, ext_name + ".pem")

    # Remove stale output so we can detect success
    for p in (out_crx, out_pem):
        try: os.remove(p)
        except FileNotFoundError: pass

    print("[INFO] Closing Chrome so pack-extension works...")
    kill_chrome()

    cmd = [chrome_exe, "--pack-extension=" + ext_dir]
    if pem_path and os.path.exists(pem_path):
        cmd.append("--pack-extension-key=" + pem_path)

    print("[INFO] Packing extension (this may take a few seconds)...")
    try:
        subprocess.run(cmd, timeout=30,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"[WARN] Chrome pack command error: {e}")

    # Move outputs into NativeHost/
    dest_crx = os.path.join(here, "extension.crx")
    dest_pem = os.path.join(here, "extension.pem")
    moved_crx = False
    if os.path.exists(out_crx):
        shutil.copy2(out_crx, dest_crx)
        os.remove(out_crx)
        moved_crx = True
    if os.path.exists(out_pem) and not os.path.exists(dest_pem):
        shutil.copy2(out_pem, dest_pem)
        os.remove(out_pem)
    elif os.path.exists(out_pem):
        os.remove(out_pem)

    return dest_crx if moved_crx else None


def register_policy(ext_id: str, crx_path: str, xml_path: str):
    """
    Write ExtensionInstallForcelist to HKLM (machine-wide).
    install.bat now runs as Administrator so this always succeeds.
    Also writes to HKCU as a fallback.
    """
    crx_url = "file:///" + crx_path.replace("\\", "/")
    xml_url = "file:///" + xml_path.replace("\\", "/")

    with open(xml_path, "w", encoding="utf-8") as f:
        f.write(f"""<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='{ext_id}'>
    <updatecheck codebase='{crx_url}' version='2.0.0' />
  </app>
</gupdate>""")

    policy_val = f"{ext_id};{xml_url}"

    # Try HKLM first (machine-wide, most reliable)
    for hive, hive_name in [
        (winreg.HKEY_LOCAL_MACHINE, "HKLM"),
        (winreg.HKEY_CURRENT_USER,  "HKCU"),
    ]:
        try:
            k = winreg.CreateKey(hive, POLICY_REG_KEY)
            winreg.SetValueEx(k, "1", 0, winreg.REG_SZ, policy_val)
            winreg.CloseKey(k)
            print(f"[OK]  ExtensionInstallForcelist -> {hive_name}")
            break
        except Exception as e:
            print(f"[WARN] {hive_name} policy write failed: {e}")

    # Allowlist (belt-and-suspenders)
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            k = winreg.CreateKey(hive, ALLOWLIST_KEY)
            winreg.SetValueEx(k, "1", 0, winreg.REG_SZ, ext_id)
            winreg.CloseKey(k)
            break
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("TabGroup Master -- Setup")
print("=" * 60)

# ── Step 1: Determine extension ID ────────────────────────────────────────────
# Store pem/crx OUTSIDE the extension directory to avoid Chrome's .pem warning
_appdata_dir = os.path.join(os.environ.get("LOCALAPPDATA", here), "TabGroupMaster")
os.makedirs(_appdata_dir, exist_ok=True)
pem_path = os.path.join(_appdata_dir, "extension.pem")
crx_path = os.path.join(_appdata_dir, "extension.crx")
xml_path = os.path.join(here, "update_manifest.xml")  # xml stays in NativeHost (not private)

# Try to get current ID from manifest.json
current_der = read_manifest_key_der()
EXT_ID = ext_id_from_der(current_der) if current_der else ""
if EXT_ID:
    print(f"[INFO] Current extension ID: {EXT_ID}")

# ── Step 2: Pack extension as .crx ────────────────────────────────────────────
chrome_exe = find_chrome_exe()
packed_crx = None

crx_already_exists = os.path.exists(crx_path) and os.path.exists(pem_path)

if not chrome_exe:
    print("[WARN] Chrome.exe not found. Skipping CRX pack.")
elif crx_already_exists:
    # CRX + PEM already exist from a previous run — skip repacking (no Chrome kill needed)
    print("[INFO] CRX already exists, skipping repack.")
    packed_crx = crx_path
else:
    print(f"[INFO] Chrome: {chrome_exe}")
    if os.path.exists(pem_path):
        print("[INFO] Using existing .pem (extension ID preserved).")
    else:
        print("[INFO] No .pem -- new key will be generated (ID changes once).")

    packed_crx = build_crx_with_chrome(chrome_exe, pem_path if os.path.exists(pem_path) else None)

    if packed_crx:
        print(f"[OK]  CRX created: {packed_crx}")
        pub_key = parse_crx_pubkey(packed_crx)
        if pub_key:
            new_id     = ext_id_from_der(pub_key)
            pub_key_b64 = base64.b64encode(pub_key).decode()
            print(f"[OK]  Extension ID from CRX: {new_id}")

            # Update manifest.json key if changed
            mfst_path = os.path.join(ext_dir, "manifest.json")
            try:
                with open(mfst_path, "r", encoding="utf-8") as f:
                    mfst = json.load(f)
                if mfst.get("key") != pub_key_b64:
                    mfst["key"] = pub_key_b64
                    with open(mfst_path, "w", encoding="utf-8") as f:
                        json.dump(mfst, f, indent=2)
                    print("[OK]  manifest.json key updated.")
            except Exception as e:
                print(f"[WARN] Could not update manifest.json: {e}")

            EXT_ID = new_id
            register_policy(EXT_ID, packed_crx, xml_path)
        else:
            print("[WARN] Could not parse CRX header.")
    else:
        print("[WARN] CRX was not created by Chrome.")
        print("       Possible reason: Chrome was already running and forwarded the")
        print("       pack request to an existing window that ignored it.")
        print("       -> Close Chrome, then run install.bat again.")

# Fall back to ID from manifest.json if pack didn't happen
if not EXT_ID:
    EXT_ID = "jdkmjfpnajeaiojbmagembcihnjckooh"
    print(f"[INFO] Using fallback extension ID: {EXT_ID}")

print(f"\n[INFO] Extension ID in use: {EXT_ID}")

# ── Step 3: Native host bat + JSON ────────────────────────────────────────────
exe_path = os.path.join(here, "importer.exe")
bat_path = os.path.join(here, "run_host.bat")

if os.path.exists(exe_path):
    host_path = exe_path
else:
    with open(bat_path, "w") as f:
        f.write(f'@echo off\n"{sys.executable}" "{os.path.join(here, "importer.py")}"\n')
    host_path = bat_path

manifest_json_path = os.path.join(here, f"{HOST_NAME}.json")
native_manifest = {
    "name": HOST_NAME,
    "description": "TabGroup Master Native Host",
    "path": host_path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{EXT_ID}/"],
}
with open(manifest_json_path, "w") as f:
    json.dump(native_manifest, f, indent=2)

# ── Step 4: Register native messaging host ────────────────────────────────────
try:
    k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, NATIVE_REG_KEY)
    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifest_json_path)
    winreg.CloseKey(k)
    print(f"[OK]  Native host registered.")
except Exception as e:
    print(f"[ERROR] Registry write failed: {e}")
    sys.exit(1)

# ── Step 5: Scheduled task (re-register on every Windows login) ───────────────
task_cmd = (f'schtasks /create /f /tn "{SCHED_TASK_NAME}" '
            f'/tr "\\"{sys.executable}\\" \\"{os.path.abspath(__file__)}\\"" '
            f'/sc ONLOGON /rl HIGHEST /ru "{os.environ.get("USERNAME", "")}"')
try:
    r = subprocess.run(task_cmd, shell=True, capture_output=True, text=True, timeout=15)
    if r.returncode == 0:
        print(f"[OK]  Scheduled task '{SCHED_TASK_NAME}' created (runs on Windows login).")
    else:
        print(f"[WARN] Scheduled task: {r.stderr.strip()}")
except Exception as ex:
    print(f"[WARN] Scheduled task: {ex}")

# ── Done ───────────────────────────────────────────────────────────────────────
print()
print("=" * 60)
print("Setup complete!")
print(f"Extension ID: {EXT_ID}")
print()
if packed_crx and os.path.exists(packed_crx):
    print("NEXT STEPS:")
    print("  1. Close Chrome completely (all windows).")
    print("  2. Reopen Chrome.")
    print("     -> Extension installs AUTOMATICALLY from policy.")
    print("     -> It will NEVER be removed on sign-out again.")
    print("  3. If you see two TabGroup Master entries in chrome://extensions,")
    print("     remove the old 'Load unpacked' version (keep the policy one).")
else:
    print("CRX packing did not complete. To fix:")
    print("  1. Close Chrome completely.")
    print("  2. Run install.bat again.")
    print("  3. Reopen Chrome.")
print("=" * 60)
