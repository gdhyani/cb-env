/** S9 / FR-AGT-008: strips credentials from anything written to logs. */
type Replacer = string | ((match: string, ...groups: string[]) => string);

/**
 * M8: a bare `Basic <token>` is a credential only when the token is padded base64 (RFC 7617) that decodes to
 * printable text containing `:` (user:password). Prose such as "Basic configuration" is left alone.
 */
function looksLikeBasicCredentials(token: string): boolean {
  if (token.length < 4 || token.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return false;
  const decoded = Buffer.from(token, "base64").toString("utf8");
  if (!decoded.includes(":")) return false;
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0xfffd) return false; // control bytes or invalid UTF-8: not text
  }
  return true;
}

const PATTERNS: [RegExp, Replacer][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)\s+[^\s"',]+/gi, "$1$2 [redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [
    /\bbasic\s+([A-Za-z0-9+/=]+)(?![A-Za-z0-9+/=])/gi,
    (match, token) => (looksLikeBasicCredentials(token) ? "Basic [redacted]" : match),
  ],
  // cb device tokens and other long token-like runs (32+ url-safe characters).
  [/\bcbd_[A-Za-z0-9_-]+/g, "cbd_[redacted]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce(
    (out, [pattern, replacement]) =>
      typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement),
    text,
  );
}
