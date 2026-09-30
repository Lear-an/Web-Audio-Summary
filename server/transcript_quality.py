"""Conservative caption-boundary and conditional transcription verification."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


def normalized(value: str) -> str:
    return "".join(char.casefold() for char in unicodedata.normalize("NFKC", value) if char.isalnum())


def repeated_prefix(previous: str, current: str) -> str:
    """Remove only a long, exact token overlap; ambiguity leaves the text intact."""
    before = re.findall(r"\S+", previous)
    after = list(re.finditer(r"\S+", current))
    left = [normalized(word) for word in before]
    right = [normalized(match.group()) for match in after]
    for count in range(min(len(left), len(right) - 1, 8), 2, -1):
        shared = right[:count]
        if all(shared) and sum(map(len, shared)) >= 12 and left[-count:] == shared:
            return current[after[count].start():].strip()
    return current


def verification_reason(text: str, audio_signal_status: str, duration_ms: int, previous_text: str) -> str | None:
    if audio_signal_status == "quiet":
        return None
    if not text.strip():
        return "empty"
    if audio_signal_status != "non_silent":
        return None
    if duration_ms >= 10_000 and len(normalized(text)) < 12:
        return "short"
    if previous_text and repeated_prefix(previous_text, text) != text:
        return "boundary"
    if duration_ms >= 10_000 and len(normalized(text)) >= 18 and not re.search(r"[.!?。！？]\s*$", text):
        return "cutoff"
    return None


def current_from_review(previous_text: str, review_text: str) -> str | None:
    """Extract the current part only when the earlier caption anchors the review."""
    earlier = normalized(previous_text)
    wider = normalized(review_text)
    if len(earlier) < 16 or len(wider) <= len(earlier):
        return None
    match = SequenceMatcher(None, earlier, wider[: max(1, len(wider) * 2 // 3)], autojunk=False).find_longest_match()
    if match.size < 12 or match.a + match.size < len(earlier) * 0.7:
        return None
    target = match.b + match.size
    consumed = 0
    cut = len(review_text)
    for index, char in enumerate(review_text):
        consumed += len(normalized(char))
        if consumed >= target:
            cut = index + 1
            break
    candidate = review_text[cut:].strip(" \t\r\n,.;:!?，。！？")
    return candidate or None


def choose_verified(first: str, second: str, reason: str) -> bool:
    """Accept a longer alternative only when it broadly agrees with the first pass."""
    initial = normalized(first)
    alternative = normalized(second)
    if not alternative:
        return False
    if not initial:
        return True
    if len(alternative) <= len(initial):
        return False
    if reason in {"short", "cutoff"} and len(initial) >= 6 and alternative.startswith(initial):
        return True
    similarity = SequenceMatcher(None, initial, alternative, autojunk=False).ratio()
    return similarity >= (0.65 if reason in {"short", "cutoff"} else 0.8)
