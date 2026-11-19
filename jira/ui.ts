// Styles and small helpers shared by the Jira page's tabs.
import { useCallback } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

export const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Opens an issue through BB, which follows Settings → General → Links: the
 * in-app browser, or with that off, the system default browser.
 */
export function useOpen(): (url: string) => void {
  const navigate = useBbNavigate();
  return useCallback(
    (url: string) => {
      if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
    [navigate],
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
