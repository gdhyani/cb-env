import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiErrorBodySchema, apiPaginatedSchema, apiSuccessSchema } from "../../src/shared/envelope";

const pagination = { page: 1, pageSize: 20, total: 1, totalPages: 1, hasNext: false, hasPrev: false };

describe("envelope schemas (PRD §12.7)", () => {
  it("accepts a success body", () => {
    const schema = apiSuccessSchema(z.object({ id: z.string() }));
    expect(schema.parse({ success: true, data: { id: "a" }, meta: { correlationId: "c" } }).data.id).toBe("a");
  });

  it("accepts a paginated body", () => {
    const schema = apiPaginatedSchema(z.object({ id: z.string() }));
    const body = { success: true, data: [{ id: "a" }], meta: { correlationId: "c", pagination } };
    expect(schema.parse(body).meta.pagination.total).toBe(1);
  });

  it("accepts an error body and rejects malformed ones", () => {
    const body = { success: false, error: { code: "NOT_FOUND", message: "m", statusCode: 404, correlationId: "c" } };
    expect(ApiErrorBodySchema.safeParse(body).success).toBe(true);
    expect(ApiErrorBodySchema.safeParse({ success: false, error: { code: 1 } }).success).toBe(false);
    expect(apiSuccessSchema(z.string()).safeParse({ success: true, data: "x" }).success).toBe(false);
  });
});
