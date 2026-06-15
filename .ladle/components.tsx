import type { GlobalProvider } from "@ladle/react";
import { ServicesProvider } from "../src/services/services-provider";
import "../src/styles/index.css";

export const Provider: GlobalProvider = ({ children }) => (
  <ServicesProvider>
    <div className="bg-surface p-6 text-ink-body">{children}</div>
  </ServicesProvider>
);
