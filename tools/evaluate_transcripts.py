"""Compare human reference captions with saved captions from a JSONL sample.

Each line: {"reference": "...", "hypothesis": "...", "category": "boundary"}.
Category may be speech, boundary, terminology, noisy, or quiet. Keep the
same labeled lines when comparing two transcription versions.
"""

from __future__ import annotations

import argparse
import json
import unicodedata
from collections import defaultdict
from pathlib import Path


def normalized(value: str) -> str:
    return "".join(char.casefold() for char in unicodedata.normalize("NFKC", value) if char.isalnum())


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row, char in enumerate(left, 1):
        current = [row]
        for column, other in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (char != other)))
        previous = current
    return previous[-1]


def evaluate(path: Path) -> dict:
    groups = defaultdict(lambda: {"samples": 0, "reference_chars": 0, "edit_chars": 0, "empty_with_speech": 0})
    for number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw.strip():
            continue
        row = json.loads(raw)
        if not isinstance(row.get("reference"), str) or not isinstance(row.get("hypothesis"), str):
            raise ValueError(f"line {number}: reference and hypothesis must be strings")
        reference = normalized(row["reference"])
        hypothesis = normalized(row["hypothesis"])
        category = str(row.get("category") or "speech")
        for key in ("all", category):
            group = groups[key]
            group["samples"] += 1
            group["reference_chars"] += len(reference)
            group["edit_chars"] += edit_distance(reference, hypothesis)
            group["empty_with_speech"] += bool(reference and (not hypothesis or row["hypothesis"].strip() == "..."))
    return {
        key: {**value, "cer": round(value["edit_chars"] / value["reference_chars"], 4) if value["reference_chars"] else None}
        for key, value in sorted(groups.items())
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure caption character errors against human references")
    parser.add_argument("jsonl", type=Path)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.jsonl), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
