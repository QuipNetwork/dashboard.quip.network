import { create } from "zustand";
import type { BlockRecord, NodesSnapshot, TelemetryResponse } from "../types/telemetry";

interface TelemetryState {
  blocks: BlockRecord[];
  nodes: NodesSnapshot | null;
  selfAddress: string | null;
  loading: boolean;
  error: string | null;

  fetchTelemetry: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  blocks: [],
  nodes: null,
  selfAddress: null,
  loading: true,
  error: null,

  fetchTelemetry: async () => {
    if (!get().loading) set({ loading: true });
    try {
      const res = await fetch("/api/telemetry");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TelemetryResponse;
      set({
        blocks: data.blocks,
        nodes: data.nodes,
        selfAddress: data.selfAddress ?? null,
        loading: false,
        error: null,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "Failed to load telemetry" });
    }
  },
}));
