// bb-plugin-github-notify — frontend.
//
// - Notifier: an app-wide overlay that renders nothing. It listens for the
//   server's notification signals and shows each one as a toast with an Open
//   action and, when allowed, a system notification that opens it on click.
// - The GitHub Notify page: recent notifications, newest first. Opening it
//   marks everything read; the sidebar entry shows the unread count.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { FEED_CHANNEL, NOTIFY_CHANNEL, eventSchema, type Feed, type NotifyEvent } from "./shared";

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

/** The feed, refetched whenever a notification arrives or the feed is viewed or cleared. */
function useFeed(): { feed: Feed | null; refetch: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [feed, setFeed] = useState<Feed | null>(null);
  const refetch = useCallback(() => {
    rpc.call("feed_get", null).then(setFeed, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(NOTIFY_CHANNEL, refetch);
  useRealtime(FEED_CHANNEL, refetch);
  return { feed, refetch };
}

function unreadCount(feed: Feed): number {
  return feed.events.filter((e) => feed.viewedAt === null || e.receivedAt > feed.viewedAt).length;
}

function UnreadBadge() {
  const { feed } = useFeed();
  const count = feed === null ? 0 : unreadCount(feed);
  if (count === 0) return null;
  return (
    <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function reasonIcon(reason: string): string {
  switch (reason) {
    case "assign":
      return "UserPlus";
    case "review_requested":
      return "Eye";
    case "mention":
    case "team_mention":
      return "AtSign";
    case "comment":
      return "MessageSquare";
    default:
      return "GitPullRequest";
  }
}

function Row({ event, unread, now }: { event: NotifyEvent; unread: boolean; now: number }) {
  const navigate = useBbNavigate();
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate.openUrl(event.url)}
        className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3 text-left text-sm hover:bg-accent"
      >
        <Icon name={reasonIcon(event.reason)} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-medium text-foreground">{event.headline}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{reference(event)}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ago(event.receivedAt, now)}</span>
          </span>
          <span className="break-words text-foreground">{event.title}</span>
          {event.excerpt !== null && (
            <span className="line-clamp-2 break-words text-muted-foreground">{event.excerpt}</span>
          )}
        </span>
        {unread && <span aria-label="unread" className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
      </button>
    </li>
  );
}

function FeedPage() {
  const rpc = useRpc<typeof rpcContract>();
  const { feed } = useFeed();
  // Unread dots use the viewedAt from when the page opened, so they stay
  // visible for this visit even though opening it marks everything read.
  const [openedViewedAt, setOpenedViewedAt] = useState<string | null | undefined>(undefined);
  const marked = useRef(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (feed === null || marked.current) return;
    marked.current = true;
    setOpenedViewedAt(feed.viewedAt);
    void rpc.call("feed_mark_viewed", null).catch(() => undefined);
  }, [feed, rpc]);

  // New arrivals while the page is open are read as soon as they show.
  useRealtime(NOTIFY_CHANNEL, () => {
    void rpc.call("feed_mark_viewed", null).catch(() => undefined);
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (feed === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const isUnread = (e: NotifyEvent) =>
    openedViewedAt !== undefined && (openedViewedAt === null || e.receivedAt > openedViewedAt);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">GitHub notifications</h1>
        <span className="text-xs text-muted-foreground">
          {feed.lastPollAt === null ? "not polled yet" : `checked ${ago(feed.lastPollAt, now)}`}
        </span>
        {feed.events.length > 0 && (
          <button
            type="button"
            onClick={() => void rpc.call("feed_clear", null)}
            className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
          >
            Clear
          </button>
        )}
      </header>
      {feed.lastError !== null && (
        <p className="rounded-md border border-border p-3 text-sm text-destructive">{feed.lastError}</p>
      )}
      {feed.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. New comments, reviews, assignments, and mentions on your pull requests show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {feed.events.map((event) => (
            <Row key={`${event.id}:${event.updatedAt}`} event={event} unread={isUnread(event)} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "notifier", component: Notifier });
  app.slots.navPanel({
    id: "feed",
    title: "GitHub Notify",
    icon: "Bell",
    path: "feed",
    component: FeedPage,
    experimental_sidebarAccessory: UnreadBadge,
  });
});
