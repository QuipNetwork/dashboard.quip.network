import { create } from "zustand";
import type { BlockRecord, MinerCategory, NodesSnapshot } from "../types/telemetry";
import { defaultBlocks, defaultNodes } from "../data/stub-telemetry";

interface TelemetryState {
  blocks: BlockRecord[];
  nodes: NodesSnapshot;
  selectedTypes: MinerCategory[];

  toggleMinerType: (type: MinerCategory) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  blocks: defaultBlocks,
  nodes: defaultNodes,
  selectedTypes: ["CPU", "GPU", "QPU"],

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
