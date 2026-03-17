import type { GlobalProvider } from "@ladle/react";
import "../src/styles/index.css";

export const Provider: GlobalProvider = ({ children }) => (
  <div className="bg-brand-gray-0 p-6 text-brand-gray-4">{children}</div>
);
