// Colored glyphs for issue types, priorities, and people. BB's icon set has
// no issue-type or priority marks, and these carry their own colors, so they
// are drawn here rather than through experimental_Icon.
import type { CSSProperties } from "react";

/** The plugin's ticket mark, registered as the shared app icon "jira.ticket". */
export function TicketGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}

type TypeStyle = { color: string; glyph: "bug" | "story" | "epic" | "subtask" | "task" };

function typeStyle(name: string): TypeStyle {
  const n = name.toLowerCase();
  if (n.includes("bug") || n.includes("incident")) return { color: "#e5493a", glyph: "bug" };
  if (n.includes("story")) return { color: "#36b37e", glyph: "story" };
  if (n.includes("epic")) return { color: "#8f7ee7", glyph: "epic" };
  if (n.includes("sub")) return { color: "#4bade8", glyph: "subtask" };
  return { color: "#4c9aff", glyph: "task" };
}

/** A filled rounded square in the type's color with a white mark, as Jira draws them. */
export function IssueTypeIcon({ type, className = "size-4" }: { type: string; className?: string }) {
  const { color, glyph } = typeStyle(type);
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} role="img" aria-label={type}>
      <title>{type}</title>
      <rect width="16" height="16" rx="3" fill={color} />
      {glyph === "bug" ? (
        <circle cx="8" cy="8" r="3.25" fill="#fff" />
      ) : glyph === "story" ? (
        <path d="M5 3.5h6v9L8 10.5 5 12.5z" fill="#fff" />
      ) : glyph === "epic" ? (
        <path d="M9.2 2.8 4.8 8.6h3l-1 4.6 4.4-5.8h-3z" fill="#fff" />
      ) : glyph === "subtask" ? (
        <>
          <rect x="3.5" y="3.5" width="5" height="5" rx="1" fill="none" stroke="#fff" strokeWidth="1.4" />
          <rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="#fff" />
        </>
      ) : (
        <path d="m4.5 8.2 2.3 2.3 4.7-4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function priorityStyle(name: string): { color: string; rank: -2 | -1 | 0 | 1 | 2 } {
  const n = name.toLowerCase();
  if (n.includes("highest") || n.includes("blocker") || n.includes("critical")) return { color: "#e5493a", rank: 2 };
  if (n.includes("high") || n.includes("major")) return { color: "#f15c3c", rank: 1 };
  if (n.includes("lowest") || n.includes("trivial")) return { color: "#4c9aff", rank: -2 };
  if (n.includes("low") || n.includes("minor")) return { color: "#2d8cff", rank: -1 };
  return { color: "#ffab00", rank: 0 };
}

/** Jira-style priority chevrons: up in reds, down in blues, medium as amber bars. */
export function PriorityIcon({ priority, className = "size-4" }: { priority: string; className?: string }) {
  const { color, rank } = priorityStyle(priority);
  const chevron = (y: number, up: boolean) => (
    <path
      key={y}
      d={up ? `M3.5 ${y + 3}L8 ${y}l4.5 3` : `M3.5 ${y}L8 ${y + 3}l4.5-3`}
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} role="img" aria-label={`${priority} priority`}>
      <title>{`${priority} priority`}</title>
      {rank === 0 ? (
        <>
          <path d="M3.5 6.5h9" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M3.5 9.5h9" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : rank > 0 ? (
        rank === 2 ? [chevron(3.5, true), chevron(8, true)] : chevron(5.5, true)
      ) : rank === -2 ? (
        [chevron(4.5, false), chevron(9, false)]
      ) : (
        chevron(6.5, false)
      )}
    </svg>
  );
}

const PALETTE = ["#4c9aff", "#36b37e", "#8f7ee7", "#ff8b00", "#00b8d9", "#e5493a", "#6554c0", "#ffab00"];

/** A stable color for a name or project key. */
export function hashColor(value: string): string {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export function Avatar({ name, className = "size-5 text-[10px]" }: { name: string | null; className?: string }) {
  if (name === null) {
    return (
      <span
        title="Unassigned"
        className={`inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-muted-foreground ${className}`}
      >
        ?
      </span>
    );
  }
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <span
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{ backgroundColor: hashColor(name) }}
    >
      {initials}
    </span>
  );
}
