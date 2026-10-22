// bb-plugin-usage-meter — backend.
//
// One RPC, meter_get, returns everything the composer badge shows for a
// thread: context window usage (bb.sdk.threads.context) and the thread
// provider's rate-limit windows, read from that provider plugin's
// provider-usage.v1 RPCs (the same source BB's Provider usage plugin uses).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { meterSchema, type Meter, type UsageWindow } from "./shared";

export const rpcContract = defineRpcContract({
  meter_get: {
    input: z.object({ threadId: z.string().min(1).max(128) }),
    output: meterSchema,
  },
});

// Output schemas for the provider-usage.v1 contract; only the fields we use.
const resourcesSchema = z.object({
  resources: z.array(
    z.object({ id: z.string(), providerId: z.string(), label: z.string() }).passthrough(),
  ),
});
const resourceSchema = z
  .object({
    observedAt: z.number().nullable().optional(),
    usage: z
      .object({
        status: z.string(),
        planLabel: z.string().nullable().optional(),
        windows: z
          .array(
            z
              .object({
                kind: z.string().optional(),
                label: z.string(),
                usedPercent: z.number(),
                resetsAt: z.string().nullable().optional(),
                model: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const USAGE_TTL_MS = 60_000;
const KINDS = new Set(["five-hour", "daily", "weekly", "custom"]);

export default async function plugin(bb: BbPluginApi) {
  const usageCache = new Map<string, { at: number; value: Meter["provider"] }>();

  async function providerUsage(providerId: string): Promise<Meter["provider"]> {
    const cached = usageCache.get(providerId);
    if (cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
    const pluginId = `provider-${providerId}`;
    let value: Meter["provider"] = null;
    try {
      const { resources } = await bb.sdk.plugins.callRpc({
        pluginId,
        method: "provider-usage.v1.listResources",
        input: {},
        outputSchema: resourcesSchema,
      });
      const resource = resources.find((r) => r.providerId === providerId) ?? resources[0];
      if (resource) {
        const result = await bb.sdk.plugins.callRpc({
          pluginId,
          method: "provider-usage.v1.getResource",
          input: { resourceId: resource.id, refresh: false },
          outputSchema: resourceSchema,
        });
        const windows: UsageWindow[] = (result.usage.windows ?? []).map((w) => ({
          kind: (KINDS.has(w.kind ?? "") ? w.kind : "custom") as UsageWindow["kind"],
          label: w.label,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ?? null,
          model: w.model ?? null,
        }));
        value = {
          label: resource.label,
          planLabel: result.usage.planLabel ?? null,
          status: result.usage.status,
          windows,
          observedAt: result.observedAt ?? null,
        };
      }
    } catch (cause) {
      bb.log.warn(
        `provider usage unavailable for ${providerId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    usageCache.set(providerId, { at: Date.now(), value });
    return value;
  }

  bb.rpc.register(rpcContract, {
    async meter_get({ threadId }) {
      const [thread, context] = await Promise.all([
        bb.sdk.threads.get({ threadId }).catch(() => null),
        bb.sdk.threads.context({ threadId }).catch(() => null),
      ]);
      const usage = (context as { usage?: { usedTokens?: number | null; modelContextWindow?: number | null; estimated?: boolean } } | null)?.usage;
      const ctx =
        usage && typeof usage.usedTokens === "number" && typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0
          ? { usedTokens: usage.usedTokens, windowTokens: usage.modelContextWindow, estimated: usage.estimated ?? false }
          : null;
      const providerId = (thread as { providerId?: string | null } | null)?.providerId ?? null;
      return {
        context: ctx,
        provider: providerId ? await providerUsage(providerId) : null,
      };
    },
  });

  bb.onDispose(() => usageCache.clear());
}
