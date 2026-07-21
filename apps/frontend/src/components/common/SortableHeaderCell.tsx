// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

interface SortableHeaderCellProps<C extends string> {
  label: string;
  column: C;
  // Null when the table is in its natural order (no column clicked yet).
  sort: { column: C; direction: "asc" | "desc" } | null;
  onClick: (column: C) => void;
  align?: "left" | "right";
  // Spacing/visibility classes matching the host table's cells; defaults to
  // the standard px-4 py-2 grid.
  className?: string;
  // Hover tooltip explaining the column.
  title?: string;
}

/**
 * Clickable `<th>` for sortable tables: highlights the active column and
 * renders a ▲/▼ direction indicator. The owning table's sort hook decides
 * toggle semantics; this cell only reports clicks.
 */
export function SortableHeaderCell<C extends string>({
  label,
  column,
  sort,
  onClick,
  align = "left",
  className = "px-4 py-2",
  title,
}: SortableHeaderCellProps<C>) {
  const direction = sort !== null && sort.column === column ? sort.direction : null;
  const indicator = direction === null ? "" : direction === "asc" ? " ▲" : " ▼";
  return (
    <th
      className={clsx(
        "cursor-pointer select-none hover:text-ink-strong",
        className,
        align === "right" && "text-right",
        direction !== null && "text-ink-strong",
      )}
      onClick={() => onClick(column)}
      aria-sort={direction === null ? "none" : direction === "asc" ? "ascending" : "descending"}
      title={title}
    >
      {label}
      {indicator}
    </th>
  );
}
