import { create } from "zustand";
import type { MinerCategory } from "../types/telemetry";

export type AggregationMode = "byType" | "byNode";

interface UIState {
  aggregationMode: AggregationMode;
  selectedTypes: MinerCategory[];

  setAggregationMode: (mode: AggregationMode) => void;
  toggleMinerType: (type: MinerCategory) => void;
}

export const useUIStore = create<UIState>((set) => ({
  aggregationMode: "byType",
  selectedTypes: ["CPU", "GPU", "QPU"],

  setAggregationMode: (mode) => set({ aggregationMode: mode }),

  toggleMinerType: (type) =>
    set((state) => {
      const has = state.selectedTypes.includes(type);
      if (has && state.selectedTypes.length === 1) return state;
      return {
        selectedTypes: has
          ? state.selectedTypes.filter((t) => t !== type)
          : [...state.selectedTypes, type],
      };
    }),
}));
