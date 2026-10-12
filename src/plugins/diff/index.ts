// Shared response-diff library (ARCHITECTURE.md §5.4). Pure, no I/O. Both the
// API client and the Proxy/Repeater import this to compare two responses
// (current vs previous send, or any two history rows).

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Classic LCS line diff. Fine for response bodies up to a few thousand lines;
 *  callers cap/prettify before diffing (e.g. JSON.stringify with 2-space indent). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: x[i++] });
    } else {
      out.push({ type: 'add', text: y[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: x[i++] });
  while (j < m) out.push({ type: 'add', text: y[j++] });
  return out;
}

/** Try to pretty-print JSON for a more meaningful line diff; fall back to raw. */
export function prettyForDiff(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
