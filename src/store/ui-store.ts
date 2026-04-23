import { create } from "zustand";
import type { MinerCategory } from "../types/telemetry";

export type AggregationMode = "byType" | "byNode";
export type ViewMode = "my-node" | "network" | "compute";
// "all" means no epoch filter; an epoch-id hash string narrows every chart
// and stat to that epoch. Stored on the UI store so it persists across
// view switches.
export type EpochFilter = string | "all";

interface UIState {
  viewMode: ViewMode;
  aggregationMode: AggregationMode;
  selectedTypes: MinerCategory[];
  selectedEpoch: EpochFilter;

  setViewMode: (mode: ViewMode) => void;
  setAggregationMode: (mode: AggregationMode) => void;
  toggleMinerType: (type: MinerCategory) => void;
  setSelectedEpoch: (epoch: EpochFilter) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "my-node",
  aggregationMode: "byType",
  selectedTypes: ["CPU", "GPU", "QPU"],
  selectedEpoch: "all",

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

  setSelectedEpoch: (epoch) => set({ selectedEpoch: epoch }),
}));
