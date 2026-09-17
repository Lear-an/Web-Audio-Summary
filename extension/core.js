(function initializeLectureCore(root, factory) {
  const api = factory();
  root.LectureCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createLectureCore() {
  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function bigrams(value) {
    const normalized = normalizeText(value);
    if (normalized.length < 2) return normalized ? [normalized] : [];
    const result = [];
    for (let index = 0; index < normalized.length - 1; index += 1) {
      result.push(normalized.slice(index, index + 2));
    }
    return result;
  }

  function diceSimilarity(left, right) {
    const a = bigrams(left);
    const b = bigrams(right);
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const counts = new Map();
    for (const gram of a) counts.set(gram, (counts.get(gram) || 0) + 1);

    let intersection = 0;
    for (const gram of b) {
      const count = counts.get(gram) || 0;
      if (count > 0) {
        intersection += 1;
        counts.set(gram, count - 1);
      }
    }
    return (2 * intersection) / (a.length + b.length);
  }

  function rangesOverlap(left, right, toleranceMs = 500) {
    return (
      Number(left.start_ms) <= Number(right.end_ms) + toleranceMs &&
      Number(right.start_ms) <= Number(left.end_ms) + toleranceMs
    );
  }

  function isLikelyDuplicate(left, right) {
    if (!rangesOverlap(left, right)) return false;
    const a = normalizeText(left.text);
    const b = normalizeText(right.text);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    return diceSimilarity(a, b) >= 0.68;
  }

  function dedupeIncoming(previous, incoming) {
    const reference = Array.isArray(previous) ? previous : [];
    return (Array.isArray(incoming) ? incoming : []).filter(
      (candidate) => !reference.some((item) => isLikelyDuplicate(item, candidate))
    );
  }

  function clampNumber(value, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return minimum;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function formatTimestamp(milliseconds, separator = ".") {
    const safe = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1_000);
    const millis = safe % 1_000;
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":") + separator + String(millis).padStart(3, "0");
  }

  function formatClock(milliseconds) {
    const safe = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1_000);
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function isRetryableStatus(status) {
    const value = Number(status);
    if (value === 429) return false;
    return value === 408 || value === 425 || value >= 500;
  }

  return Object.freeze({
    normalizeText,
    diceSimilarity,
    isLikelyDuplicate,
    dedupeIncoming,
    clampNumber,
    formatTimestamp,
    formatClock,
    isRetryableStatus
  });
});
