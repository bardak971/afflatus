import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { reloadOnStaleChunks } from "./reload";
import "./styles.css";
import { applyTheme, useThemeChoice } from "./theme/store";

// before anything is drawn: the page is never seen in another theme than the one that was chosen
applyTheme(useThemeChoice.getState());
reloadOnStaleChunks();

// the server pushes what changed (live.ts), so queries do not refetch on their own
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary whole>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
