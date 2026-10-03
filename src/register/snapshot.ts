import fs from "node:fs";
import { MSG } from "../constants";
import type { Snapshot } from "../shared/schemas";

// Hand-written validation keeps the preload fast (FR-REG-007): no zod on the hot path.
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");
const isIntRecord = (v: unknown): v is Record<string, number> =>
  typeof v === "object" && v !== null && Object.values(v).every((x) => Number.isInteger(x));

export function readSnapshotSync(file: string): Snapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(MSG.snapshotMissing(file));
  }
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(MSG.snapshotInvalid(file, "not JSON"));
  }
  const fail = (field: string): never => {
    throw new Error(MSG.snapshotInvalid(file, field));
  };
  if (s.schema !== 1) fail("schema");
  if (s.status !== "active" && s.status !== "revoked") fail("status");
  if (!isStringRecord(s.env)) fail("env");
  if (!isIntRecord(s.redirects)) fail("redirects");
  if (typeof s.orgCaCert !== "string") fail("orgCaCert");
  return s as unknown as Snapshot;
}
