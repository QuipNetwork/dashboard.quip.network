import type { MinerCategory } from "../types/telemetry";

export interface HistogramData {
  data: Array<Record<string, string | number>>;
  keys: MinerCategory[];
}

export function buildHistogram(
  values: Array<{ value: number; minerCategory: MinerCategory; unitCount: number }>,
  selectedTypes: MinerCategory[],
  options?: { binCount?: number; precision?: number },
): HistogramData {
  const empty: HistogramData = { data: [], keys: [] };
  if (values.length === 0) return empty;

  const allValues = values.map((v) => v.value);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);

  if (min === max) {
    const label = min.toPrecision(3);
    const row: Record<string, string | number> = { bin: label };
    for (const t of selectedTypes) row[t] = 0;
    for (const v of values) {
      row[v.minerCategory] = (row[v.minerCategory] as number) + 1 / v.unitCount;
    }
    return { data: [row], keys: [...selectedTypes] };
  }

  const binCount =
    options?.binCount ?? Math.min(15, Math.max(5, Math.ceil(Math.log2(values.length) + 1)));
  const binWidth = (max - min) / binCount;
  const precision = options?.precision ?? (max - min > 100 ? 0 : 1);

  // Build bins
  const bins: Array<{ label: string }> = [];
  for (let i = 0; i < binCount; i++) {
    const lo = min + i * binWidth;
    bins.push({ label: lo.toFixed(precision) });
  }

  // Initialize rows
  const rows: Array<Record<string, string | number>> = bins.map((b) => {
    const row: Record<string, string | number> = { bin: b.label };
    for (const t of selectedTypes) row[t] = 0;
    return row;
  });

  // Fill bins
  for (const v of values) {
    let idx = Math.floor((v.value - min) / binWidth);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    const row = rows[idx];
    if (row) {
      row[v.minerCategory] = (row[v.minerCategory] as number) + 1 / v.unitCount;
    }
  }

  // Round values for display
  for (const row of rows) {
    for (const t of selectedTypes) {
      row[t] = Math.round((row[t] as number) * 1000) / 1000;
    }
  }

  return { data: rows, keys: [...selectedTypes] };
}
