import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CbError } from "../../src/shared/errors";
import { createBackendClient } from "../../src/shared/http";
import { fail, ok, startStubServer } from "../helpers/stub-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pagination = { page: 1, pageSize: 2, total: 3, totalPages: 2, hasNext: true, hasPrev: false };
let stub: Awaited<ReturnType<typeof startStubServer>> | undefined;
afterEach(async () => stub?.close());

describe("backend client (PRD §12.7)", () => {
  it("sends correlation id and bearer token, returns data", async () => {
    stub = await startStubServer({ "/api/x": ok({ id: "a" }) });
    const client = createBackendClient({ serverUrl: stub.url, token: "TOK" });
    expect(await client.get("/api/x", z.object({ id: z.string() }))).toEqual({ id: "a" });
    expect(stub.seen[0]?.["x-correlation-id"]).toMatch(UUID);
    expect(stub.seen[0]?.authorization).toBe("Bearer TOK");
  });

  it("uses one correlation id for every call of a command", async () => {
    stub = await startStubServer({ "/api/x": ok(1) });
    const client = createBackendClient({ serverUrl: stub.url, correlationId: "cmd-1" });
    await client.get("/api/x", z.number());
    await client.get("/api/x", z.number());
    expect(stub.seen.map((h) => h["x-correlation-id"])).toEqual(["cmd-1", "cmd-1"]);
    expect(stub.seen[0]?.authorization).toBeUndefined();
  });

  it("returns items and pagination for lists", async () => {
    stub = await startStubServer({
      "/api/list": { status: 200, body: { success: true, data: [1, 2], meta: { correlationId: "c", pagination } } },
    });
    const client = createBackendClient({ serverUrl: stub.url });
    expect(await client.getPaginated("/api/list", z.number())).toEqual({ items: [1, 2], pagination });
  });

  it("maps the error envelope to CbError", async () => {
    stub = await startStubServer({ "/api/x": fail(404, "PROJECT_NOT_FOUND", "Project not found", "c-404") });
    const err = await createBackendClient({ serverUrl: stub.url })
      .get("/api/x", z.unknown())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CbError);
    expect(err).toMatchObject({
      code: "PROJECT_NOT_FOUND",
      message: "Project not found",
      statusCode: 404,
      correlationId: "c-404",
    });
  });

  it("reports an unreachable backend with the Appendix B message", async () => {
    const err = await createBackendClient({ serverUrl: "http://127.0.0.1:1" })
      .get("/api/x", z.unknown())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BACKEND_UNREACHABLE" });
    expect((err as Error).message).toBe(
      "cb: can't reach http://127.0.0.1:1. Gateway-only mode needs the backend for every connection.",
    );
  });

  it("rejects non-envelope responses as BAD_RESPONSE", async () => {
    stub = await startStubServer({ "/api/x": { status: 200, body: "<html>proxy</html>", contentType: "text/html" } });
    const err = await createBackendClient({ serverUrl: stub.url })
      .get("/api/x", z.unknown())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BAD_RESPONSE" });
  });
});
