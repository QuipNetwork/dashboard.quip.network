// SPDX-License-Identifier: AGPL-3.0-or-later

import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from "react-simple-maps";

import type { LocatedNode } from "./use-compute-available";

interface NodeLocationMapProps {
  nodes: LocatedNode[];
  unlocatedCount: number;
}

// World atlas TopoJSON served from unpkg — same source used by
// react-simple-maps' own examples. Cached by the browser across reloads;
// falls through to an empty map (see Geographies render fallback) if the
// request fails.
const GEO_URL = "https://unpkg.com/world-atlas@2.0.2/countries-110m.json";

const NODE_COLOR = "#059669";

export function NodeLocationMap({ nodes, unlocatedCount }: NodeLocationMapProps) {
  const hasAny = nodes.length > 0;

  return (
    <div className="relative h-full w-full">
      <ComposableMap
        projectionConfig={{ scale: 147 }}
        projection="geoEqualEarth"
        width={980}
        height={440}
        style={{ width: "100%", height: "100%" }}
      >
        <ZoomableGroup center={[0, 20]} zoom={1} maxZoom={6}>
          <Geographies geography={GEO_URL}>
            {({ geographies }) =>
              geographies.map((geo: { rsmKey: string }) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="#e4e4e7"
                  stroke="#d4d4d8"
                  strokeWidth={0.5}
                  style={{
                    default: { outline: "none" },
                    hover: { fill: "#dbdbde", outline: "none" },
                    pressed: { fill: "#dbdbde", outline: "none" },
                  }}
                />
              ))
            }
          </Geographies>
          {nodes.map((n) => {
            const r = markerRadius(n.tflops);
            return (
              <Marker key={n.address} coordinates={[n.lng, n.lat]}>
                <circle r={r} fill={`${NODE_COLOR}55`} stroke={NODE_COLOR} strokeWidth={1} />
                <title>
                  {n.nodeName} — {[n.city, n.country].filter(Boolean).join(", ")}
                  {n.tflops > 0 ? ` · ${n.tflops.toFixed(1)} TFLOPS` : ""}
                </title>
              </Marker>
            );
          })}
        </ZoomableGroup>
      </ComposableMap>

      {(unlocatedCount > 0 || !hasAny) && (
        <p className="absolute right-3 bottom-2 font-accent text-[10px] uppercase tracking-wider text-ink-subtle">
          {hasAny
            ? `${unlocatedCount} node${unlocatedCount === 1 ? "" : "s"} unlocated`
            : "No located nodes — operators haven't published publicHost, or geo lookup is disabled"}
        </p>
      )}
    </div>
  );
}

// Scale marker radius by ~log of TFLOPS so a 100-TFLOPS node isn't 10×
// the size of a 10-TFLOPS node — the eye reads log-area more naturally
// for compute share.
function markerRadius(tflops: number): number {
  if (tflops <= 0) return 3;
  return 3 + Math.log10(1 + tflops) * 2.5;
}
