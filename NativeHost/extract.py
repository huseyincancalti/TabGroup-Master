import os
import sys
import json

import tabgroups


def main():
    data = tabgroups.extract()
    if len(sys.argv) > 1:
        out_path = sys.argv[1]
    else:
        desktop = os.path.join(os.path.expanduser("~"), "Desktop")
        target_dir = desktop if os.path.isdir(desktop) else os.path.expanduser("~")
        out_path = os.path.join(target_dir, "TabGroups_Export.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    groups = data.get("savedGroups", [])
    tabs = sum(g.get("tabCount", 0) for g in groups)
    print(f"Exported {len(groups)} groups / {tabs} tabs")
    print(f"-> {out_path}")
    if data.get("error"):
        print("Note:", data["error"])


if __name__ == "__main__":
    main()
