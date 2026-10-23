// Small UI memory: in-module for instant reads, mirrored to localStorage so it survives reloads.
export const memo = new Map<string, string>();
export function recall(key: string): string | null {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  try {
    const stored = window.localStorage.getItem(`rfcs:${key}`);
    if (stored !== null) memo.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}
export function remember(key: string, value: string | null) {
  if (value === null) memo.delete(key);
  else memo.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(`rfcs:${key}`);
    else window.localStorage.setItem(`rfcs:${key}`, value);
  } catch {
    // storage full or blocked: in-module memory still works
  }
}

