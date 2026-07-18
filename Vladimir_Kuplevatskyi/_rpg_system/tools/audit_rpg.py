#!/usr/bin/env python3
"""Read-only audit for the Vladimir_Kuplevatskyi RPG folder.

The script prints structure, expected file presence, file hashes and large-file
signals. It never writes, renames, deletes or edits project files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

EXPECTED_TOP_LEVEL = [
    "README.md",
    "SYSTEM_INDEX.md",
    "AGENT_OPERATIONS.md",
    "CONTROL_PANEL.md",
    "game-loop.md",
    "reward-table.md",
    "risk-gates.md",
    "stats.md",
    "inventory.md",
    "quests.md",
    "goals.md",
    "planner.md",
    "habit-tracker.md",
    "diary.md",
    "logbook.md",
    "battle-log.md",
    "records.md",
    "training-log.md",
    "skill-log.md",
    "skills.md",
    "achievements.md",
    "map.md",
    "worldview.md",
    "sync-audit.md",
    "pattern-register.md",
]

EXPECTED_DIRS = [
    "checklists",
    "MONEY",
    "nova",
    "reflections",
    "relationships",
    "study-hub",
    "_rpg_system",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def first_heading(path: Path) -> str | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith("#"):
                    return stripped
    except UnicodeDecodeError:
        return "<non-utf8>"
    return None


def collect() -> dict[str, object]:
    markdown_files = sorted(ROOT.rglob("*.md"))
    all_files = sorted(path for path in ROOT.rglob("*") if path.is_file())
    missing_files = [name for name in EXPECTED_TOP_LEVEL if not (ROOT / name).is_file()]
    missing_dirs = [name for name in EXPECTED_DIRS if not (ROOT / name).is_dir()]

    records = []
    for path in all_files:
        rel = path.relative_to(ROOT).as_posix()
        stat = path.stat()
        item: dict[str, object] = {
            "path": rel,
            "bytes": stat.st_size,
            "sha256": sha256(path),
        }
        if path.suffix.lower() == ".md":
            item["heading"] = first_heading(path)
        records.append(item)

    large_markdown = [
        item for item in records
        if str(item["path"]).endswith(".md") and int(item["bytes"]) > 50_000
    ]

    return {
        "root": str(ROOT),
        "file_count": len(all_files),
        "markdown_count": len(markdown_files),
        "missing_files": missing_files,
        "missing_dirs": missing_dirs,
        "large_markdown": large_markdown,
        "files": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print full JSON inventory")
    args = parser.parse_args()

    data = collect()
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print(f"RPG root: {data['root']}")
    print(f"Files: {data['file_count']}")
    print(f"Markdown files: {data['markdown_count']}")

    missing_files = data["missing_files"]
    missing_dirs = data["missing_dirs"]
    if missing_files:
        print("Missing files:")
        for name in missing_files:
            print(f"  - {name}")
    else:
        print("Missing files: none")

    if missing_dirs:
        print("Missing dirs:")
        for name in missing_dirs:
            print(f"  - {name}")
    else:
        print("Missing dirs: none")

    large_markdown = data["large_markdown"]
    if large_markdown:
        print("Large markdown files:")
        for item in large_markdown:
            print(f"  - {item['path']} ({item['bytes']} bytes)")
    else:
        print("Large markdown files: none")

    return 1 if missing_files or missing_dirs else 0


if __name__ == "__main__":
    raise SystemExit(main())
