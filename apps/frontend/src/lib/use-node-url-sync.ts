// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";

import { nodeSearch, parseNodeParam } from "@/lib/node-url";
import { useUIStore } from "@/store/ui-store";

// Fallback tab when a ?node link is cleared via back/forward and there's no
// prior in-app view to restore.
const FALLBACK_VIEW = "network" as const;

/**
 * Two-way sync between the `?node=<ss58>` URL param and the UI store, so the
 * Node detail page is shareable and back/forward-navigable without a router.
 *
 * - On mount and on `popstate`: adopt the URL's node selection (or leave "node"
 *   view when the param disappears).
 * - On store change: reflect the current node selection into the address bar
 *   via `pushState`, diffing first so tab switches don't spam history.
 *
 * Scoped to the node param only — the main tabs are intentionally not synced.
 */
export function useNodeUrlSync(): void {
  const viewMode = useUIStore((s) => s.viewMode);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const openNode = useUIStore((s) => s.openNode);
  const setViewMode = useUIStore((s) => s.setViewMode);

  useEffect(() => {
    const applyFromUrl = () => {
      const id = parseNodeParam(window.location.search);
      if (id) openNode(id);
      else if (useUIStore.getState().viewMode === "node") setViewMode(FALLBACK_VIEW);
    };
    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
  }, [openNode, setViewMode]);

  useEffect(() => {
    const desired = nodeSearch(viewMode === "node" ? selectedNodeId : null);
    if (desired !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.pushState(null, "", `${pathname}${desired}${hash}`);
    }
  }, [viewMode, selectedNodeId]);
}
