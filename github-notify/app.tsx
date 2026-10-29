// bb-plugin-github-notify — frontend.
//
// An app-wide overlay that renders nothing: it listens for the server's
// notification signals and shows each one as a toast with an Open action
// and, when allowed, a system notification that opens the PR on click.
import { useCallback, useEffect } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { NOTIFY_CHANNEL, eventSchema, type NotifyEvent } from "./shared";

function reference(event: NotifyEvent): string {
  return event.number === null ? event.repo : `${event.repo}#${event.number}`;
}

function Notifier() {
  const { values } = useSettings();
  const navigate = useBbNavigate();
  const desktop = values?.desktop !== false;

  useEffect(() => {
    if (desktop && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, [desktop]);

  const show = useCallback(
    (payload: unknown) => {
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success) return;
      const event = parsed.data;
      const title = `${event.headline} · ${reference(event)}`;
      const body = event.excerpt === null ? event.title : `${event.title}\n${event.excerpt}`;
      const open = () => navigate.openUrl(event.url);
      toast(title, {
        id: `github-notify:${event.id}:${event.updatedAt}`,
        description: body,
        duration: 10_000,
        action: { label: "Open", onClick: open },
      });
      if (desktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const notification = new Notification(title, { body, tag: event.id });
        notification.onclick = () => {
          window.focus();
          open();
          notification.close();
        };
      }
    },
    [desktop, navigate],
  );

  useRealtime(NOTIFY_CHANNEL, show);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "notifier", component: Notifier });
});
