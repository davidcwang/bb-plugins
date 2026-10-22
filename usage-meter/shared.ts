// Wire types shared by server.ts and app.tsx. The account email and plan id
// never leave the server: only percentages, labels and reset times do.
import { z } from "zod";

export const windowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof windowSchema>;

export const meterSchema = z.object({
  context: z
    .object({
      usedTokens: z.number(),
      windowTokens: z.number(),
      estimated: z.boolean(),
    })
    .nullable(),
  provider: z
    .object({
      label: z.string(),
      planLabel: z.string().nullable(),
      status: z.string(),
      windows: z.array(windowSchema),
      observedAt: z.number().nullable(),
    })
    .nullable(),
});
export type Meter = z.infer<typeof meterSchema>;
