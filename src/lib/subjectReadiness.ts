const PLACEHOLDER_SUBJECT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bdrafts?\b/i, label: "draft" },
  { pattern: /\btests?(?:ing)?\b/i, label: "test" },
  { pattern: /\bplaceholders?\b/i, label: "placeholder" },
  { pattern: /\bsamples?\b/i, label: "sample" },
  { pattern: /\buntitled\b/i, label: "untitled" },
  { pattern: /\b(?:todo|tbd)\b/i, label: "TODO/TBD" },
  { pattern: /\blorem ipsum\b/i, label: "lorem ipsum" },
];

export function subjectPlaceholderTerms(subject: string): string[] {
  return PLACEHOLDER_SUBJECT_PATTERNS
    .filter(({ pattern }) => pattern.test(subject))
    .map(({ label }) => label);
}

export function assertSendReadySubject(subject: string): void {
  const terms = subjectPlaceholderTerms(subject);
  if (terms.length > 0) {
    throw new Error(
      `Subject is not send-ready: remove placeholder term${terms.length === 1 ? "" : "s"} ${terms.join(", ")}.`,
    );
  }
}
