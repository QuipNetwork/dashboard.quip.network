import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { MinerCategory } from "@quip/shared/telemetry";

export type AggregationMode = "byType" | "byNode";
export type ViewMode = "my-node" | "network" | "compute" | "chain";

export interface UIState {
  viewMode: ViewMode;
  aggregationMode: AggregationMode;
  selectedTypes: MinerCategory[];

  setViewMode: (mode: ViewMode) => void;
  setAggregationMode: (mode: AggregationMode) => void;
  toggleMinerType: (type: MinerCategory) => void;
}

export const createUIStore = (): StoreApi<UIState> =>
  createStore<UIState>((set) => ({
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

export const uiStore = createUIStore();

export const UIStoreContext = createContext<StoreApi<UIState>>(uiStore);

const identity = <T>(state: T): T => state;

function useUIStoreBase<T = UIState>(
  selector: (state: UIState) => T = identity as (state: UIState) => T,
): T {
  return useStore(useContext(UIStoreContext), selector);
}

export const useUIStore: typeof useUIStoreBase & StoreApi<UIState> = Object.assign(
  useUIStoreBase,
  uiStore,
);
