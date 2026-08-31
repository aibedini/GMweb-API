import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./index.css";

// §41: UI is a projection of the local store; the sync engine (lib/sync.ts)
// owns IndexedDB and cursor logic. WebSocket/SSE only invalidate, never feed
// the UI directly.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
