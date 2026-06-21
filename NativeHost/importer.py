import sys
import os
import json
import struct

import tabgroups

# ── CRITICAL (Windows): put stdin/stdout into BINARY mode ──────────────────────
# Native messaging is a raw binary protocol (4-byte little-endian length + JSON).
# On Windows, stdout defaults to TEXT mode, which silently rewrites every 0x0A
# (\n) byte to 0x0D 0x0A (\r\n). That corrupts both the length header and any
# newline byte inside the JSON, so Chrome immediately drops the connection —
# which looks like "native host not found / disconnected" even though the .bat
# ran fine. Forcing binary mode is the fix.
if sys.platform == "win32":
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("@I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    # ensure_ascii=False keeps non-ASCII (Turkish/emoji) as compact UTF-8 instead
    # of 6-byte \uXXXX escapes, so chunk size math stays predictable.
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# Chrome drops the native-messaging port if any single host->extension message
# exceeds 1 MB. A full export (and a large workspace backup) easily passes that,
# so we slice the JSON payload into chunks well under the limit and let the
# extension reassemble them.
CHUNK_CHARS = 256 * 1024


def send_chunked(result_action, chunk_action, data):
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    total = max(1, (len(payload) + CHUNK_CHARS - 1) // CHUNK_CHARS)
    for i in range(total):
        send_message({
            "action": chunk_action,
            "index": i,
            "total": total,
            "data": payload[i * CHUNK_CHARS:(i + 1) * CHUNK_CHARS],
        })
    send_message({"action": result_action, "ok": True, "chunked": True, "total": total})


def send_extract(data):
    send_chunked("extractResult", "extractChunk", data)


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
                send_extract(data)
            except Exception as exc:
                send_message({"action": "extractResult", "ok": False, "error": str(exc)})
        elif action == "saveBackup":
            try:
                ok = tabgroups.save_backup(message.get("data") or {}, message.get("key"))
                send_message({"action": "saveBackupResult", "ok": ok})
            except Exception as exc:
                send_message({"action": "saveBackupResult", "ok": False, "error": str(exc)})
        elif action == "loadBackup":
            try:
                data = tabgroups.load_backup(message.get("key"))
                if data is None:
                    send_message({"action": "loadBackupResult", "ok": False, "data": None})
                else:
                    # Chunked like extract: a large workspace backup (> 1 MB)
                    # would otherwise kill the port and make restore silently fail.
                    send_chunked("loadBackupResult", "loadBackupChunk", data)
            except Exception as exc:
                send_message({"action": "loadBackupResult", "ok": False, "data": None, "error": str(exc)})


if __name__ == "__main__":
    main()
