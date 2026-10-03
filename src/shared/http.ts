import type { z } from "zod";
import { CORRELATION_HEADER, MSG, REQUEST_TIMEOUT_MS } from "../constants";
import { newCorrelationId } from "./correlation";
import { ApiErrorBodySchema, apiPaginatedSchema, apiSuccessSchema, type Pagination } from "./envelope";
import { CbError } from "./errors";

export interface BackendClientOptions {
  serverUrl: string;
  token?: string;
  correlationId?: string;
}

export interface BackendClient {
  readonly correlationId: string;
  get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>>;
  post<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>>;
  getPaginated<T extends z.ZodType>(path: string, item: T): Promise<{ items: z.infer<T>[]; pagination: Pagination }>;
}

export function createBackendClient(opts: BackendClientOptions): BackendClient {
  const correlationId = opts.correlationId ?? newCorrelationId();

  async function request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: "application/json", [CORRELATION_HEADER]: correlationId };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(new URL(path, opts.serverUrl), {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new CbError("BACKEND_UNREACHABLE", MSG.unreachable(opts.serverUrl), { correlationId, cause });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CbError("BAD_RESPONSE", MSG.badResponse(opts.serverUrl, res.status), {
        statusCode: res.status,
        correlationId,
      });
    }
    const error = ApiErrorBodySchema.safeParse(body);
    if (error.success) {
      const e = error.data.error;
      throw new CbError(e.code, e.message, { statusCode: e.statusCode, correlationId: e.correlationId });
    }
    return { status: res.status, body };
  }

  function badResponse(status: number): CbError {
    return new CbError("BAD_RESPONSE", MSG.badResponse(opts.serverUrl, status), { statusCode: status, correlationId });
  }

  return {
    correlationId,
    async get(path, schema) {
      const { status, body } = await request(path);
      const parsed = apiSuccessSchema(schema).safeParse(body);
      if (!parsed.success) throw badResponse(status);
      // zod cannot infer through the generic envelope; the schema above guarantees this shape.
      return (parsed.data as { data: z.infer<typeof schema> }).data;
    },
    async post(path, body, schema) {
      const { status, body: resBody } = await request(path, { method: "POST", body });
      const parsed = apiSuccessSchema(schema).safeParse(resBody);
      if (!parsed.success) throw badResponse(status);
      // Same generic-inference limitation as get().
      return (parsed.data as { data: z.infer<typeof schema> }).data;
    },
    async getPaginated(path, item) {
      const { status, body } = await request(path);
      const parsed = apiPaginatedSchema(item).safeParse(body);
      if (!parsed.success) throw badResponse(status);
      // Same generic-inference limitation as get(); the schema guarantees this shape.
      const page = parsed.data as { data: z.infer<typeof item>[]; meta: { pagination: Pagination } };
      return { items: page.data, pagination: page.meta.pagination };
    },
  };
}
