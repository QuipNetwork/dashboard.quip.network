// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SVGProps } from "react";

import { energyToCurveRatio } from "@/lib/difficulty-curve";

// Structural subset of nivo's AxisTickProps — everything the renderer reads.
// Accepting a subset keeps us decoupled from @nivo/axes internals while
// remaining assignable to the axis `renderTick` slot.
export interface DifficultyTickProps {
  value: string | number;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  textX: number;
  textY: number;
  rotate?: number;
  textAnchor: string;
  textBaseline: string;
  opacity?: number;
}

// Colors/sizes mirror nivoTheme's axis ticks (custom renderTick bypasses the
// theme).
const LINE_STROKE = "#d4d4d8";
const TEXT_STYLE = {
  fill: "#52525c",
  fontSize: 11,
  fontFamily: "'ABC Favorit Mono', monospace",
} as const;
// Advance width of the monospace tick font at 11px — lets us center the two
// lines on each other while keeping the block's right edge at the tick point
// (where nivo puts end-anchored rotated ticks).
const CHAR_WIDTH = 6.6;

/**
 * Two-line angled tick for the difficulty axes: the curve ratio c = -E/K
 * over the raw energy — "0.746" / "(-14540)" — so neither collides with its
 * neighbour nor gets dropped. Falls back to a single raw-energy line when the
 * curve constant K is unknown (pre-v0.2 / no default topology).
 */
export function createDifficultyTickRenderer(k: number | null) {
  return function DifficultyTick(tick: DifficultyTickProps) {
    const energy = Math.round(Number(tick.value));
    const ratio = energyToCurveRatio(energy, k);
    const top = ratio == null ? null : ratio.toFixed(3);
    const bottom = `(${energy})`;
    // Center both lines on the midpoint of the wider one, so the shorter
    // ratio line sits centered over the energy line instead of flush right.
    const center = top == null ? 0 : -(Math.max(top.length, bottom.length) * CHAR_WIDTH) / 2;
    return (
      <g transform={`translate(${tick.x},${tick.y})`} style={{ opacity: tick.opacity ?? 1 }}>
        <line x1={0} y1={0} x2={tick.lineX} y2={tick.lineY} stroke={LINE_STROKE} strokeWidth={1} />
        <g transform={`translate(${tick.textX},${tick.textY}) rotate(${tick.rotate ?? 0})`}>
          <text
            // nivo hands textBaseline through as a plain string; React's SVG
            // props want the literal unions.
            textAnchor={
              top == null ? (tick.textAnchor as SVGProps<SVGTextElement>["textAnchor"]) : "middle"
            }
            dominantBaseline={tick.textBaseline as SVGProps<SVGTextElement>["dominantBaseline"]}
            style={TEXT_STYLE}
          >
            {top == null ? (
              <tspan x={0}>{energy}</tspan>
            ) : (
              <>
                <tspan x={center}>{top}</tspan>
                <tspan x={center} dy={12}>
                  {bottom}
                </tspan>
              </>
            )}
          </text>
        </g>
      </g>
    );
  };
}
