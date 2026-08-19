import { z } from 'zod';

export const uuid = z.string().uuid();
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const cursorLimit = z.object({
  cursor: z.string().nullable().optional().default(null),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export const expectedVersion = z.object({ expected_version: z.number().int().min(1) }).strict();
export const versionedReason = z
  .object({
    expected_version: z.number().int().min(1),
    reason: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const dailyContent = z
  .object({
    completed_today: z.string().max(20_000),
    next_plan: z.string().max(20_000),
    blockers: z.string().max(20_000),
    other: z.string().max(20_000),
    free_text: z.string().max(20_000).nullable(),
  })
  .strict();

export const evidence = z
  .object({
    kind: z.enum(['url', 'text', 'file_ref']),
    label: z.string().max(200),
    value: z.string().max(10_000),
  })
  .strict();

export const requirementBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(20_000),
    acceptance_criteria: z.array(z.string().trim().min(1)).max(50),
  })
  .strict();

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const parsed = z
    .string()
    .min(8)
    .max(128)
    .safeParse(Array.isArray(value) ? value[0] : value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
