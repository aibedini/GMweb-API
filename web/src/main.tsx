import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, Toast } from "@heroui/react";
import App from "./app/App";
import "./index.css";

// §41: UI is a projection of the local store; the sync engine (lib/sync.ts)
// owns IndexedDB and cursor logic. SSE only invalidates, never feeds the UI.
//
// HeroUI v3 is React-Aria-based: `I18nProvider` is the app-level provider and
// `Toast.Provider` mounts the toast viewport. HeroUIProvider does not exist in
// v3 and must not be added.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider locale="en-US">
      <Toast.Provider />
      <App />
    </I18nProvider>
  </StrictMode>,
);
