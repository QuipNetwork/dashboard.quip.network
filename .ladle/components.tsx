import type { GlobalProvider } from "@ladle/react";
import { ServicesProvider } from "../src/services/services-provider";
import "../src/styles/index.css";

export const Provider: GlobalProvider = ({ children }) => (
  <ServicesProvider>
    <div className="bg-brand-gray-0 p-6 text-brand-gray-4">{children}</div>
  </ServicesProvider>
);
