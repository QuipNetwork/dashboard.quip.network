import type { CustomLayerProps } from "@nivo/line";
import { getSeriesGradient } from "../../../lib/chart-colors";

export interface GradientStop {
  offset: string;
  color: string;
  opacity?: number;
}

export type SeriesGradientStops = Record<string, GradientStop[]>;

export function createGradientLines(stops: SeriesGradientStops, strokeWidth = 2) {
  return function GradientLines({ series, lineGenerator, innerWidth }: CustomLayerProps) {
    return (
      <>
        <defs>
          {series.map((s) => {
            const seriesStops: GradientStop[] =
              stops[s.id] ??
              (() => {
                const [from, to] = getSeriesGradient(String(s.id));
                return [
                  { offset: "0%", color: from },
                  { offset: "100%", color: to },
                ];
              })();
            return (
              <linearGradient
                key={s.id}
                id={`line-gradient-${s.id}`}
                x1="0"
                y1="0"
                x2={innerWidth}
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                {seriesStops.map((stop, i) => (
                  <stop
                    key={i}
                    offset={stop.offset}
                    stopColor={stop.color}
                    stopOpacity={stop.opacity}
                  />
                ))}
              </linearGradient>
            );
          })}
        </defs>
        {series.map((s) => (
          <path
            key={s.id}
            d={lineGenerator(s.data.map((d) => d.position)) ?? undefined}
            fill="none"
            stroke={`url(#line-gradient-${s.id})`}
            strokeWidth={strokeWidth}
          />
        ))}
      </>
    );
  };
}
