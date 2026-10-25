import { z } from "zod";

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  vault: z.boolean(),
});

export type Health = z.infer<typeof HealthSchema>;

/** ok is true only when both databases answered. */
export function makeHealth(db: boolean, vault: boolean): Health {
  return { ok: db && vault, db, vault };
}
