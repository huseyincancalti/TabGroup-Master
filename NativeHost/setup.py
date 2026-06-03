import json
import os
import sys

try:
    import winreg
except ImportError:
    print("ERROR: This script must be run on Windows.")
    sys.exit(1)

EXT_ID = "jdkmjfpnajeaiojbmagembcihnjckooh"
HOST_NAME = "com.tabgroup.master"
REG_KEY = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"

here = os.path.dirname(os.path.abspath(__file__))
exe = os.path.join(here, "importer.exe")
bat = os.path.join(here, "run_host.bat")

if os.path.exists(exe):
    host_path = exe
else:
    with open(bat, "w") as f:
        script = os.path.join(here, "importer.py")
        f.write(f'@echo off\n"{sys.executable}" "{script}"\n')
    host_path = bat

manifest_path = os.path.join(here, f"{HOST_NAME}.json")
manifest = {
    "name": HOST_NAME,
    "description": "TabGroup Master Native Host",
    "path": host_path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{EXT_ID}/"],
}

with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=2)

try:
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_KEY)
    winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
    winreg.CloseKey(key)
    print(f"[OK] Native host registered: {manifest_path}")
    print("Restart Chrome if it was already open.")
except Exception as e:
    print(f"[ERROR] Registry write failed: {e}")
    print("Try running as Administrator.")
    sys.exit(1)
