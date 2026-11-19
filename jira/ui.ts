// Styles and small helpers shared by the Jira page's tabs.
import { useCallback } from "react";
import { useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";

export const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Opens an issue. BB's in-app browser is usually not signed in to Jira, so by
 * default a `_blank` window hands the URL to the system browser instead.
 */
export function useOpen(): (url: string) => void {
  const { values } = useSettings();
  const navigate = useBbNavigate();
  const external = values?.openInBrowser !== false;
  return useCallback(
    (url: string) => {
      if (!external || window.open(url, "_blank", "noopener,noreferrer") === null) navigate.openUrl(url);
    },
    [external, navigate],
  );
}

export function ago(iso: string | null): string {
  if (iso === null) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Jira's blue, used for the plugin's accents. */
export const BRAND = "#1d7afc";

export const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-[#1d7afc] focus:ring-2 focus:ring-[#1d7afc]/25";
export const buttonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:border-[#1d7afc]/60 hover:bg-[#1d7afc]/10 disabled:opacity-50";
export const primaryClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[#1d7afc] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#0c66e4] disabled:opacity-50";
