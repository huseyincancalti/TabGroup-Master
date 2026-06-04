import sys
import json
import struct

import tabgroups


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("@I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    while True:
        message = read_message()
        if message is None:
            return
        action = message.get("action")
        if action == "listProfiles":
            try:
                profiles = tabgroups.list_profiles()
                send_message({"action": "listProfilesResult", "ok": True, "profiles": profiles})
            except Exception as exc:
                send_message({"action": "listProfilesResult", "ok": False, "error": str(exc), "profiles": []})
        elif action == "extract":
            try:
                profile_dirs = message.get("profileDirs")  # None = all profiles
                data = tabgroups.extract(profile_dirs=profile_dirs)
                send_message({"action": "extractResult", "ok": True, "data": data})
            except Exception as exc:
                send_message({"action": "extractResult", "ok": False, "error": str(exc)})
        elif action == "saveBackup":
            try:
                ok = tabgroups.save_backup(message.get("data") or {})
                send_message({"action": "saveBackupResult", "ok": ok})
            except Exception as exc:
                send_message({"action": "saveBackupResult", "ok": False, "error": str(exc)})
        elif action == "loadBackup":
            try:
                data = tabgroups.load_backup()
                send_message({"action": "loadBackupResult", "ok": data is not None, "data": data})
            except Exception as exc:
                send_message({"action": "loadBackupResult", "ok": False, "data": None, "error": str(exc)})


if __name__ == "__main__":
    main()
