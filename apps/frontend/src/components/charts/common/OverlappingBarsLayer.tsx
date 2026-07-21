import type { BarCustomLayerProps, ComputedBarDatum } from "@nivo/bar";

type Bar = ComputedBarDatum<Record<string, string | number>>;

/**
 * Custom Nivo bar layer that renders bars overlapping within each bin
 * rather than side-by-side (grouped) or stacked. Tallest bars render
 * first so shorter bars are always visible on top.
 */
export function OverlappingBarsLayer({
  bars,
}: BarCustomLayerProps<Record<string, string | number>>) {
  // Group bars by their bin (indexValue)
  const groups = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = String(bar.data.indexValue);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(bar);
  }

  return (
    <g>
      {[...groups.values()].flatMap((group) => {
        // Full bin width = from leftmost bar.x to rightmost bar.x + width
        const minX = Math.min(...group.map((b) => b.x));
        const maxXEdge = Math.max(...group.map((b) => b.x + b.width));
        const fullWidth = maxXEdge - minX;

        // Tallest first so shorter bars paint on top
        const sorted = [...group].sort((a, b) => b.height - a.height);

        return sorted.map((bar) => (
          <rect
            key={bar.key}
            x={minX}
            y={bar.y}
            width={fullWidth}
            height={bar.height}
            fill={bar.color}
            opacity={0.55}
            rx={2}
          />
        ));
      })}
    </g>
  );
}
