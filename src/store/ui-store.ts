import { create } from "zustand";
import type { MinerCategory } from "../types/telemetry";

export type AggregationMode = "byType" | "byNode";
export type ViewMode = "my-node" | "network" | "compute" | "chain";

interface UIState {
  viewMode: ViewMode;
  aggregationMode: AggregationMode;
  selectedTypes: MinerCategory[];

  setViewMode: (mode: ViewMode) => void;
  setAggregationMode: (mode: AggregationMode) => void;
  toggleMinerType: (type: MinerCategory) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "my-node",
  aggregationMode: "byType",
  selectedTypes: ["CPU", "GPU", "QPU"],

  setViewMode: (mode) => set({ viewMode: mode }),

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
