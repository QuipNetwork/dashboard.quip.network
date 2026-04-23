// Epoch IDs are 16-char hex hashes (e.g. "e0a08eef1dfff726"). They're
// opaque — no ordering or time info in the hash itself — so we render a
// short prefix. When a `firstBlockTimestamp` (block_index=1's unix seconds)
// is known, suffix the short hash with a localized date so the selector
// keeps the time cue operators used pre-cutover.
const EPOCH_ID_PREFIX_CHARS = 8;

export function formatEpochId(epochHash: string, firstBlockTimestamp?: number | null): string {
  const short =
    epochHash.length > EPOCH_ID_PREFIX_CHARS
      ? `${epochHash.slice(0, EPOCH_ID_PREFIX_CHARS)}…`
      : epochHash;
  if (firstBlockTimestamp == null || !Number.isFinite(firstBlockTimestamp)) {
    return short;
  }
  const d = new Date(firstBlockTimestamp * 1000);
  if (Number.isNaN(d.getTime())) return short;
  const when = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${short} · ${when}`;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * Render an elapsed time like "3d 4h", "12h", "45m", or "30s". Designed for
 * "time on network" displays where the two largest units are the most
 * informative — we never show three.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
