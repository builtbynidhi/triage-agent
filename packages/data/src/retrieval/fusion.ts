/**
 * Reciprocal rank fusion (Cormack, Clarke & Buettcher, 2009).
 *
 * Each list contributes 1 / (k + rank) for every item it contains (rank starts at 1).
 * It uses ranks, never raw scores, which is the point: BM25 scores and cosine similarities
 * live on unrelated scales, and RRF needs no calibration between them. k = 60 is the
 * paper's constant; it damps the gap between rank 1 and rank 2 so one list cannot dominate.
 */
export const RRF_K = 60;

export interface Fused<T> {
  item: T;
  score: number;
  /** 1-based rank of the item in each input list, or null where it was absent. */
  ranks: (number | null)[];
}

export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k: number = RRF_K,
): Fused<T>[] {
  const fused = new Map<string, Fused<T>>();
  lists.forEach((list, li) => {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      let entry = fused.get(key);
      if (!entry) {
        entry = { item, score: 0, ranks: lists.map(() => null) };
        fused.set(key, entry);
      }
      entry.score += 1 / (k + idx + 1);
      entry.ranks[li] = idx + 1;
    });
  });
  // Ties break on the best single rank, then the key, so the order is fully deterministic.
  return [...fused.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (b.score !== a.score) return b.score - a.score;
      const bestA = Math.min(...a.ranks.map((r) => r ?? Infinity));
      const bestB = Math.min(...b.ranks.map((r) => r ?? Infinity));
      return bestA !== bestB ? bestA - bestB : ka.localeCompare(kb);
    })
    .map(([, v]) => v);
}
