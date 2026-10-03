import { z } from "zod";

// PRD §12.7 — identical shapes in cb-backend and cb-dashboard.
export const PaginationSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const ApiErrorBodySchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    statusCode: z.number().int(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    correlationId: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data, meta: z.object({ correlationId: z.string() }) });
}

export function apiPaginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    success: z.literal(true),
    data: z.array(item),
    meta: z.object({ correlationId: z.string(), pagination: PaginationSchema }),
  });
}
