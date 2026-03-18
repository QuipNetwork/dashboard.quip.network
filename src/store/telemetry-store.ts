import { create } from "zustand";
import type { BlockRecord, MinerCategory, NodesSnapshot } from "../types/telemetry";

interface TelemetryState {
  blocks: BlockRecord[];
  nodes: NodesSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedTypes: MinerCategory[];

  toggleMinerType: (type: MinerCategory) => void;
  fetchTelemetry: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  blocks: [],
  nodes: null,
  loading: true,
  error: null,
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

  fetchTelemetry: async () => {
    if (!get().loading) set({ loading: true });
    try {
      const res = await fetch("/.netlify/functions/telemetry");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ blocks: data.blocks, nodes: data.nodes, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "Failed to load telemetry" });
    }
  },
}));
