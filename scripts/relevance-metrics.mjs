// Ranking metrics for the retrieval evaluation (STA-49). `ranked` is a list of document IDs, best first; `relevant`
// maps a document ID to its grade (1 or more; absent is 0).

const gain = grade => 2 ** grade - 1;

/** Normalized discounted cumulative gain at `k` (Järvelin and Kekäläinen 2002, exponential gain); 0 with no relevant document. */
export function ndcgAt(k, ranked, relevant) {
  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + gain(relevant[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(relevant).filter(grade => grade > 0).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

/** The share of relevant documents among the first `k`; 0 with no relevant document. */
export function recallAt(k, ranked, relevant) {
  const wanted = Object.keys(relevant).filter(id => relevant[id] > 0);
  if (!wanted.length) return 0;
  const top = new Set(ranked.slice(0, k));
  return wanted.filter(id => top.has(id)).length / wanted.length;
}

/** The share of the first `k` positions holding a relevant document (a short list counts its empty positions). */
export function precisionAt(k, ranked, relevant) {
  return ranked.slice(0, k).filter(id => (relevant[id] ?? 0) > 0).length / k;
}

/** The reciprocal of the first relevant document's rank; 0 when none is ranked. */
export function reciprocalRank(ranked, relevant) {
  const index = ranked.findIndex(id => (relevant[id] ?? 0) > 0);
  return index < 0 ? 0 : 1 / (index + 1);
}

/** The nearest-rank percentile `p` (0 to 100) of `values`; null for none. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
/** Round to three decimals for a published report. */
export const round = value => value === null ? null : Math.round(value * 1000) / 1000;
