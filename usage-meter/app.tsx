// bb-plugin-usage-meter — frontend.
//
// A compact read-only meter in the thread composer's action row:
//   ctx 22% · 5h 54% · wk 39%
// Hover for token counts, every limit window, and reset times.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Meter, UsageWindow } from "./shared";

const POLL_MS = 10_000;

function useMeter(threadId: string | null): Meter | null {
  const rpc = useRpc<typeof rpcContract>();
  const [meter, setMeter] = useState<Meter | null>(null);
  const load = useCallback(() => {
    if (!threadId || document.visibilityState === "hidden") return;
    rpc.call("meter_get", { threadId }).then(setMeter, () => undefined);
  }, [rpc, threadId]);
  useEffect(() => {
    setMeter(null);
    load();
    const timer = window.setInterval(load, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);
  return meter;
}

// Three tiers by how much is used:
//   < 50 %   plenty left      green
//   50–79 %  decent amount    amber
//   >= 80 %  running low      red
const TONES = {
  plenty: "#3fb37f",
  decent: "#e0a526",
  low: "#e5484d",
} as const;

function tone(percent: number): string {
  if (percent >= 80) return TONES.low;
  if (percent >= 50) return TONES.decent;
  return TONES.plenty;
}

function shortLabel(w: UsageWindow): string {
  if (w.model) return w.model.slice(0, 1).toUpperCase() + w.model.slice(1);
  if (w.kind === "five-hour") return "5h";
  if (w.kind === "weekly") return "wk";
  if (w.kind === "daily") return "day";
  return w.label;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Compact countdown for the inline readout: 37m, 4h12m, 2d3h. */
function shortReset(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function formatReset(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const ms = at.getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "resetting";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  const rel = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `resets in ${rel} (${at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})`;
}

const wrap: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 6px",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  color: "var(--muted-foreground)",
  cursor: "default",
  userSelect: "none",
};

function UsageMeter() {
  const composer = useComposer();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const meter = useMeter(threadId);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (!meter || (!meter.context && !meter.provider)) return null;

  const parts: Array<{ key: string; label: string; value: string; color?: string; reset?: string }> = [];
  const lines: string[] = [];

  if (meter.context) {
    const { usedTokens, windowTokens, estimated } = meter.context;
    const pct = Math.round((usedTokens / windowTokens) * 100);
    parts.push({ key: "ctx", label: "ctx", value: `${pct}%`, color: tone(pct) });
    lines.push(
      `Context: ${usedTokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens (${pct}%)${estimated ? ", estimated" : ""}`,
    );
  }

  const provider = meter.provider;
  if (provider) {
    if (provider.status !== "ok") {
      lines.push(`${provider.label}: usage ${provider.status.replace(/_/g, " ")}`);
    } else {
      lines.push(`${provider.label}${provider.planLabel ? ` · ${provider.planLabel}` : ""}`);
      // Badge shows the session window and the general weekly window; model
      // specific windows are shown when they are the tighter limit.
      const session = provider.windows.find((w) => w.kind === "five-hour");
      const weekly = provider.windows.find((w) => w.kind === "weekly" && !w.model);
      const tightest = provider.windows
        .filter((w) => w.model)
        .sort((a, b) => b.usedPercent - a.usedPercent)[0];
      const showTightest = tightest && (!weekly || tightest.usedPercent > weekly.usedPercent);
      // A model window that shares the weekly reset time doesn't repeat it.
      const sharedReset = showTightest && weekly && tightest!.resetsAt === weekly.resetsAt;
      for (const w of [session, weekly]) {
        if (w) {
          parts.push({
            key: w.label,
            label: shortLabel(w),
            value: `${Math.round(w.usedPercent)}%`,
            color: tone(w.usedPercent),
            reset: shortReset(w.resetsAt),
          });
        }
      }
      if (showTightest) {
        parts.push({
          key: tightest!.label,
          label: shortLabel(tightest!),
          value: `${Math.round(tightest!.usedPercent)}%`,
          color: tone(tightest!.usedPercent),
          reset: sharedReset ? undefined : shortReset(tightest!.resetsAt),
        });
      }
      for (const w of provider.windows) {
        const reset = formatReset(w.resetsAt);
        lines.push(`  ${w.label}: ${Math.round(w.usedPercent)}%${reset ? ` · ${reset}` : ""}`);
      }
      if (provider.observedAt) {
        lines.push(`Measured ${new Date(provider.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      }
    }
  }

  return (
    <span style={wrap} title={lines.join("\n")} aria-label={lines.join(". ")}>
      {parts.map((part, i) => (
        <span key={part.key} style={{ display: "inline-flex", gap: 4 }}>
          {i > 0 ? <span aria-hidden style={{ opacity: 0.4 }}>·</span> : null}
          <span>{part.label}</span>
          <span style={{ color: part.color, fontWeight: part.color === TONES.low ? 600 : 500 }}>{part.value}</span>
          {part.reset ? <span style={{ opacity: 0.6 }}>↻{part.reset}</span> : null}
        </span>
      ))}
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "usage-meter",
    scopes: ["thread"],
    actions: [{ id: "meter", component: UsageMeter }],
  });
});
