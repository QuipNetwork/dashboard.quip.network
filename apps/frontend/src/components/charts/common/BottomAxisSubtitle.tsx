// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CustomLayerProps } from "@nivo/line";

// nivo's axis legend is a single string, so an explanatory second line under
// the bottom-axis legend needs its own layer. Styled like a muted tick label.
export function createBottomAxisSubtitle(text: string, offsetY: number) {
  return function BottomAxisSubtitle({ innerWidth, innerHeight }: CustomLayerProps) {
    return (
      <text
        x={innerWidth / 2}
        y={innerHeight + offsetY}
        textAnchor="middle"
        style={{ fill: "#52525c", fontSize: 10, fontFamily: "'ABC Favorit Mono', monospace" }}
      >
        {text}
      </text>
    );
  };
}

// Shared x-axis subtitle of the by-difficulty charts, under their
// "Difficulty" axis legend.
export const difficultyAxisSubtitle = createBottomAxisSubtitle(
  "(lower energy == more difficult)",
  80,
);
