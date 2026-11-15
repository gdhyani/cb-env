import { pathToFileURL } from "node:url";

/** Quotes a path for NODE_OPTIONS (Node's own parser honours double quotes and backslash escapes). */
export function quoteNodeOption(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Adds `option` to an existing NODE_OPTIONS once. */
export function appendNodeOption(existing: string | undefined, option: string): string {
  if (!existing) return option;
  return existing.includes(option) ? existing : `${existing} ${option}`;
}

const HAS_REQUIRE = /(^|\s)(--require|-r)(=|\s)/;
const HAS_IMPORT = /(^|\s)--import(=|\s)/;

/**
 * OQ6 (FR-PKG-004): how `cb run` / `cb shell` load the preload. Tools such as Next.js re-parse NODE_OPTIONS into
 * one value per flag, so two `--require` (or two `--import`) options collapse into one broken path. cb therefore
 * uses the flag the developer's NODE_OPTIONS does not: `--import` with a file URL (no quoting, safe with spaces)
 * by default, `--require` when the developer already uses `--import`.
 */
export function preloadNodeOption(existing: string | undefined, registerPath: string): string {
  const parent = existing ?? "";
  if (HAS_IMPORT.test(parent) && !HAS_REQUIRE.test(parent)) return `--require ${quoteNodeOption(registerPath)}`;
  return `--import ${pathToFileURL(registerPath).href}`;
}
