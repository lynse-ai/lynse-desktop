import { z } from "zod";

export function parseWithFallback<T>(
  schema: z.ZodType<T>,
  data: unknown,
  fallback: T,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  console.warn("[schema] Validation failed, using fallback:", result.error);
  return fallback;
}
