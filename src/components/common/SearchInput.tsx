// SPDX-License-Identifier: AGPL-3.0-or-later

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export function SearchInput({ value, onChange, placeholder, ariaLabel }: SearchInputProps) {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? "Search"}
        className="w-full rounded-md border border-brand-gray-2 bg-transparent px-3 py-1.5 font-accent text-sm text-brand-gray-5 placeholder:text-brand-gray-3 focus:border-brand-gray-3 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer font-accent text-xs text-brand-gray-3 hover:text-brand-gray-5"
        >
          ×
        </button>
      )}
    </div>
  );
}
