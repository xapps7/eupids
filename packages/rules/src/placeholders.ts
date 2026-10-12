// D-07 — placeholder values count as missing for any identifier.

export const DEFAULT_PLACEHOLDERS = [
  "n/a",
  "na",
  "none",
  "null",
  "-",
  "--",
  "0",
  "000000",
  "tbd",
  "x",
  "unknown",
  "test",
] as const;

/** D-07: a value repeated across more than this many unrelated products is a placeholder. */
export const REPEAT_PLACEHOLDER_THRESHOLD = 5;

export function buildPlaceholderSet(extra: string[] = []): Set<string> {
  const set = new Set<string>(DEFAULT_PLACEHOLDERS);
  for (const v of extra) {
    const t = v.trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

/** Case-insensitive, after trim. Empty is not a placeholder (it is "missing"). */
export function isPlaceholder(value: string, set: Set<string>): boolean {
  const t = value.trim().toLowerCase();
  return t.length > 0 && set.has(t);
}
