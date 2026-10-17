// "Is this the same email?" by subject line, for cross-campaign duplicate
// protection. Campaigns are duplicated to split an audience into batches
// (LPs first, newsletter next...), and each copy has its own id, so the
// per-campaign dedupe hash cannot stop someone on two batch lists from getting
// the invite twice. Two campaigns count as the same email when their subjects
// are identical or at least SUBJECT_SIMILARITY_THRESHOLD similar after
// normalization.

export const SUBJECT_SIMILARITY_THRESHOLD = 0.9;

export function normalizeSubject(subject) {
  let value = String(subject ?? "").normalize("NFKC").toLowerCase();
  // Test prefixes and reply/forward markers do not make a different email.
  for (;;) {
    const next = value.replace(/^\s*(\[(test|draft)\]|re:|fwd?:)\s*/i, "");
    if (next === value) break;
    value = next;
  }
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

// 1 = identical after normalization, 0 = nothing in common.
export function subjectSimilarity(a, b) {
  const left = normalizeSubject(a);
  const right = normalizeSubject(b);
  if (!left && !right) return 1;
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
}

export function isSameEmailSubject(a, b, threshold = SUBJECT_SIMILARITY_THRESHOLD) {
  return subjectSimilarity(a, b) >= threshold;
}

// Of `candidates` ({ id, subject }), the ids whose subject matches `subject`.
export function similarCampaignIds(subject, candidates, selfId, threshold = SUBJECT_SIMILARITY_THRESHOLD) {
  return candidates
    .filter((candidate) => candidate.id !== selfId && isSameEmailSubject(subject, candidate.subject, threshold))
    .map((candidate) => candidate.id);
}
