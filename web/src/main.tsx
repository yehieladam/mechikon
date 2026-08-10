import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./i18n";
import { Analytics } from "@vercel/analytics/react";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installNetworkMonitor } from "./lib/networkMonitor";

// Patch the network primitives before anything else runs, so the trust badge counts every request.
installNetworkMonitor();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      {/* Anonymous usage analytics (Vercel Web Analytics): page views + the file_redacted custom event.
          Beacons go to same-origin /_vercel/insights and carry NO document content — only a format label.
          The network monitor excludes that path from the trust-badge count (see isAnalyticsBeacon). */}
      <Analytics />
    </ErrorBoundary>
  </React.StrictMode>,
);
