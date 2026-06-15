// SPDX-License-Identifier: AGPL-3.0-or-later

export type ClassValue = string | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(" ");
}
