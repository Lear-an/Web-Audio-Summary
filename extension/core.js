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

  function normalizedCutIndex(value, normalizedLength) {
    const text = String(value || "");
    if (normalizedLength <= 0) return 0;
    let consumed = 0;
    let index = 0;
    for (const character of text) {
      index += character.length;
      consumed += normalizeText(character).length;
      if (consumed >= normalizedLength) return index;
    }
    return text.length;
  }

  function boundaryOverlapLength(left, right, minimumLength = 4) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    const maximum = Math.min(a.length, b.length);
    const minimum = Math.max(1, Math.floor(Number(minimumLength) || 4));
    for (let length = maximum; length >= minimum; length -= 1) {
      if (a.slice(-length) !== b.slice(0, length)) continue;
      if (length / Math.min(a.length, b.length) < 0.25) continue;
      return length;
    }
    return 0;
  }

  function mergeBoundaryText(left, right, overlapLength) {
    const first = String(left || "").trim();
    const second = String(right || "").trim();
    const cutIndex = normalizedCutIndex(second, overlapLength);
    const remainder = second.slice(cutIndex).trimStart();
    if (!remainder) return first;
    const separator = /\s$/.test(first) || /^[\p{P}\p{S}]/u.test(remainder) ? "" : " ";
    return `${first}${separator}${remainder}`;
  }

  function mergedSegment(previous, incoming, text) {
    return {
      ...previous,
      text,
      start_ms: Math.min(Number(previous.start_ms) || 0, Number(incoming.start_ms) || 0),
      end_ms: Math.max(Number(previous.end_ms) || 0, Number(incoming.end_ms) || 0),
      uncertain: Boolean(previous.uncertain || incoming.uncertain),
      status: "final"
    };
  }

  function reconcileCaptionBoundary(previous, incoming, tailCount = 4) {
    const existing = (Array.isArray(previous) ? previous : []).map((item) => ({ ...item }));
    const candidates = (Array.isArray(incoming) ? incoming : []).map((item) => ({ ...item, status: "final" }));
    const boundaryStart = Math.max(0, existing.length - Math.max(1, Math.floor(Number(tailCount) || 4)));

    for (const candidate of candidates) {
      const candidateText = normalizeText(candidate.text);
      if (!candidateText) continue;
      let reconciled = false;

      for (let index = existing.length - 1; index >= boundaryStart; index -= 1) {
        const prior = existing[index];
        if (!rangesOverlap(prior, candidate)) continue;
        const priorText = normalizeText(prior.text);
        if (!priorText) continue;

        const shorterLength = Math.min(priorText.length, candidateText.length);
        const isContained = shorterLength >= 4 && (
          priorText.includes(candidateText) || candidateText.includes(priorText)
        );
        if (priorText === candidateText || isContained) {
          const preferredText = candidateText.length > priorText.length ? candidate.text : prior.text;
          existing[index] = mergedSegment(prior, candidate, preferredText);
          reconciled = true;
          break;
        }

        const overlapLength = boundaryOverlapLength(prior.text, candidate.text);
        if (overlapLength > 0) {
          existing[index] = mergedSegment(
            prior,
            candidate,
            mergeBoundaryText(prior.text, candidate.text, overlapLength)
          );
          reconciled = true;
          break;
        }

        if (shorterLength >= 4 && diceSimilarity(prior.text, candidate.text) >= 0.82) {
          const preferredText = candidateText.length > priorText.length ? candidate.text : prior.text;
          existing[index] = mergedSegment(prior, candidate, preferredText);
          reconciled = true;
          break;
        }
      }

      if (!reconciled) existing.push(candidate);
    }
    return existing;
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

  function transientRetryDelayMs(attempt) {
    const schedule = [15_000, 30_000, 45_000];
    const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    return schedule[Math.min(schedule.length - 1, safeAttempt - 1)];
  }

  function queueDrainTimeoutMs(queueCount) {
    const count = Math.max(0, Math.ceil(Number(queueCount) || 0));
    return Math.min(15 * 60_000, Math.max(5 * 60_000, count * 60_000));
  }

  return Object.freeze({
    normalizeText,
    diceSimilarity,
    isLikelyDuplicate,
    dedupeIncoming,
    boundaryOverlapLength,
    mergeBoundaryText,
    reconcileCaptionBoundary,
    clampNumber,
    formatTimestamp,
    formatClock,
    isRetryableStatus,
    transientRetryDelayMs,
    queueDrainTimeoutMs
  });
});
