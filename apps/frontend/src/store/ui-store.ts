import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { MinerCategory } from "@quip/shared/telemetry";

export type AggregationMode = "byType" | "byNode";
// "node" is the per-account detail page (reachable via the node modal's
// "More info" link and the shareable ?node=<ss58> deep-link); it is not a
// top-level tab in the header.
export type ViewMode = "my-node" | "network" | "compute" | "chain" | "node";

export interface UIState {
  viewMode: ViewMode;
  aggregationMode: AggregationMode;
  selectedTypes: MinerCategory[];
  // The account whose detail page is shown when viewMode === "node". Null
  // otherwise. Kept even when navigating away so the back button can restore it.
  selectedNodeId: string | null;

  setViewMode: (mode: ViewMode) => void;
  setAggregationMode: (mode: AggregationMode) => void;
  toggleMinerType: (type: MinerCategory) => void;
  // Open the detail page for an account (sets viewMode "node" + selectedNodeId).
  openNode: (accountId: string) => void;
}

export const createUIStore = (): StoreApi<UIState> =>
  createStore<UIState>((set) => ({
    viewMode: "my-node",
    aggregationMode: "byType",
    selectedTypes: ["CPU", "GPU", "QPU"],
    selectedNodeId: null,

    setViewMode: (mode) => set({ viewMode: mode }),

    openNode: (accountId) => set({ viewMode: "node", selectedNodeId: accountId }),

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
