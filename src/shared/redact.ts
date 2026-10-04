/** S9 / FR-AGT-008: strips credentials from anything written to logs. */
const PATTERNS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)\s+[^\s"',]+/gi, "$1$2 [redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // cb device tokens and other long token-like runs (32+ url-safe characters).
  [/\bcbd_[A-Za-z0-9_-]+/g, "cbd_[redacted]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
