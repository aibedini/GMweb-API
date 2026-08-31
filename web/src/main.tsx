import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, ToastProvider } from "@heroui/react";
import App from "./app/App";
import "./index.css";

// §41: UI is a projection of the local store; the sync engine (lib/sync.ts)
// owns IndexedDB and cursor logic. SSE only invalidates, never feeds the UI.
// HeroUI v3 is React-Aria-based: I18nProvider is the app-level provider
// (HeroUIProvider does not exist in v3 — the per-component contexts suffice).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider locale="en-US">
      <ToastProvider />
      <App />
    </I18nProvider>
  </StrictMode>,
);
