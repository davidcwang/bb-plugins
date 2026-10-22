// Values shared by server.ts and app.tsx. Keep this file free of Node imports:
// the frontend bundle includes it.
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];
