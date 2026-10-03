import { randomUUID } from "node:crypto";

/** One id per CLI command so every backend call of that command shares it in server logs. */
export function newCorrelationId(): string {
  return randomUUID();
}
