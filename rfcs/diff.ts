// Line diff for the Changes view. Myers' O(ND) algorithm over lines; no
// Node imports, the frontend bundle includes it.
export interface DiffOp {
  kind: "eq" | "add" | "del";
  /** 1-based line in the old text (eq/del). */
  a: number | null;
  /** 1-based line in the new text (eq/add). */
  b: number | null;
  text: string;
}

export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v = new Array<number>(2 * max + 2).fill(0);
  const trace: number[][] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", a: x, b: y, text: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "add", a: null, b: y, text: b[y - 1]! });
        y--;
      } else {
        ops.push({ kind: "del", a: x, b: null, text: a[x - 1]! });
        x--;
      }
    }
  }
  ops.reverse();
  return ops;
}

export interface DiffHunk {
  ops: DiffOp[];
  /** Unchanged lines skipped before this hunk. */
  skipped: number;
}

/** Group ops into hunks with `context` unchanged lines around each change. */
export function hunks(ops: DiffOp[], context = 3): DiffHunk[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === "eq") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffHunk[] = [];
  let i = 0;
  let lastEnd = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && keep[j]) j++;
    out.push({ ops: ops.slice(i, j), skipped: i - lastEnd });
    lastEnd = j;
    i = j;
  }
  return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}
