import { z } from "zod";

export class MemoryError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export const memoryKey = z.string().min(1).max(200).regex(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/, "Use lowercase segments separated by dots");
export const memoryWrite = z.strictObject({ key: memoryKey, value: z.string().max(32000), revision: z.number().int().nonnegative() });
export const memoryDelete = z.strictObject({ key: memoryKey, revision: z.number().int().positive() });
export const memoryQuery = z.strictObject({
  prefix: memoryKey.optional(), query: z.string().trim().max(200).optional(),
  after: memoryKey.optional(), limit: z.number().int().min(1).max(100).default(50),
  deleted: z.boolean().default(false),
});
export interface MemoryEntry { key: string; value: string | null; revision: number; updated: string; actor: string }
export type MemorySummary = Omit<MemoryEntry, "value"> & { deleted: boolean; excerpt: string };
export interface MemoryPage { entries: MemorySummary[]; next?: string }
export function parseMemory<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new MemoryError(result.error.issues.map(i => i.message).join("; "));
  return result.data;
}
