// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the `?node=<ss58>` deep-link that makes the Node page
// shareable without pulling in a router. `useNodeUrlSync` wires these to
// window.history + the UI store.

const PARAM = "node";

/** Extract the `node` account id from a URL search string, or null if absent. */
export function parseNodeParam(search: string): string | null {
  const value = new URLSearchParams(search).get(PARAM);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The canonical search string for a node selection: `?node=<encoded ss58>` when
 * an account is selected, or "" (no query) when not. Used to diff against the
 * live address bar so we only push history entries on an actual change.
 */
export function nodeSearch(accountId: string | null): string {
  if (!accountId) return "";
  const params = new URLSearchParams();
  params.set(PARAM, accountId);
  return `?${params.toString()}`;
}
