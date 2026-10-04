import fs from "node:fs";
import path from "node:path";

export type LeakForm = "raw" | "base64" | "base64url" | "json";
export interface ScanReport {
  leaks: { target: string; file: string; form: LeakForm }[];
  scanned: Record<string, number>;
}

/**
 * Base64 of a canary embedded anywhere in a longer stream: whatever the canary's offset modulo 3, the bytes from
 * the next 3-byte boundary onward encode to a fixed substring. One needle per alignment.
 */
function base64Needles(canary: string, url: boolean): string[] {
  const bytes = Buffer.from(canary);
  return [0, 1, 2].map((start) => {
    const slice = bytes.subarray(start, start + Math.floor((bytes.length - start) / 3) * 3);
    return slice.toString(url ? "base64url" : "base64");
  });
}

/** JSON (and V8 heap strings) may escape every non-alphanumeric character as \uXXXX. */
const jsonEscaped = (canary: string) =>
  [...canary]
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`))
    .join("");

/** Regular files only, recursively (CB_HOME also holds the agent's control socket). */
export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full) : e.isFile() ? [full] : [];
  });
}

/** §13 canary suite: every target must have evidence; any canary in any encoding is a leak. */
export function scanEvidence(canaries: string[], targets: Record<string, string[]>): ScanReport {
  for (const c of canaries) if (c.length < 8) throw new Error(`canary too short to scan reliably (${c.length} chars)`);
  const needles = canaries.map((c) => ({
    raw: [c],
    base64: base64Needles(c, false),
    base64url: base64Needles(c, true),
    json: c === jsonEscaped(c) ? [] : [jsonEscaped(c)],
  }));
  const report: ScanReport = { leaks: [], scanned: {} };
  for (const [target, files] of Object.entries(targets)) {
    if (files.length === 0) throw new Error(`no evidence for ${target}`);
    report.scanned[target] = files.length;
    for (const file of files) {
      const text = fs.readFileSync(file).toString("latin1");
      for (const forms of needles) {
        // One leak per (file, canary): the first matching form is enough (base64 and base64url often coincide).
        const hit = (Object.entries(forms) as [LeakForm, string[]][]).find(([, list]) =>
          list.some((n) => text.includes(n)),
        );
        if (hit) report.leaks.push({ target, file, form: hit[0] });
      }
    }
  }
  return report;
}
