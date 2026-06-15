import { create } from "zustand";

/**
 * Deterministic hash of a string to a number.
 * Uses djb2 — fast, low-collision for short identifiers.
 */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Generate a visually distinct HSL color from a hash.
 * Saturation and lightness are constrained to read on light backgrounds.
 */
function colorFromHash(h: number): string {
  const hue = h % 360;
  const sat = 55 + (h % 25); // 55–79%
  const lit = 38 + ((h >> 8) % 12); // 38–49%
  return hslToHex(hue, sat, lit);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

interface MinerColorsState {
  colors: Record<string, string>;
  getColor: (minerId: string) => string;
}

export const useMinerColors = create<MinerColorsState>((set, get) => ({
  colors: {},

  getColor: (minerId: string) => {
    const existing = get().colors[minerId];
    if (existing) return existing;

    const color = colorFromHash(hash(minerId));
    set((state) => ({ colors: { ...state.colors, [minerId]: color } }));
    return color;
  },
}));
