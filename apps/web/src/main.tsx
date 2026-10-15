import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { App } from "./App";
import { Gate } from "./access/Gate";
import { ErrorBoundary } from "./ErrorBoundary";
import { aroundNav, useGuardedLocation } from "./leaveGuard";
import { reloadOnStaleChunks } from "./reload";
import "./styles.css";
import { applyTheme, useThemeChoice } from "./theme/store";
import { queryKeys } from "./queryKeys";

// before anything is drawn: the page is never seen in another theme than the one that was chosen
applyTheme(useThemeChoice.getState());
reloadOnStaleChunks();

// the server pushes what changed (live.ts) and a reconnect reads everything again, so queries do not refetch on
// their own, nor each time a screen opens: what was read stays good for five minutes unless an event says otherwise
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5 * 60_000 } } });
// what no event announces, read again when a screen opens as before (or after a while): drafts (written by the server
// on a send, swept by it, and by other tabs), the disk figures (other programs fill the disk), settings and workflows
// changed in another tab, the render-time windows that end "now"; and what is read fresh each time it is opened:
// ComfyUI's log, the node packs being installed, a form's cast worked in, the prompt history
client.setQueryDefaults(queryKeys.drafts.all(), { staleTime: 30_000 });
client.setQueryDefaults(queryKeys.storage(), { staleTime: 30_000 });
client.setQueryDefaults(queryKeys.settings(), { staleTime: 60_000 });
client.setQueryDefaults(queryKeys.workflows(), { staleTime: 60_000 });
client.setQueryDefaults(queryKeys.renders.all(), { staleTime: 60_000 });
for (const fresh of [queryKeys.comfyLog(), queryKeys.packs.all(), queryKeys.compose.all(), queryKeys.promptHistory.all()]) client.setQueryDefaults(fresh, { staleTime: 0 });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary whole>
      <QueryClientProvider client={client}>
        {/* every navigation passes the leave guard, and Back/Forward too (the location it reads): a screen with unsaved work asks first */}
        <Router aroundNav={aroundNav} hook={useGuardedLocation}>
          {/* behind the password, when one is set (access/Gate.tsx): the app is drawn only once this browser is in */}
          <Gate>
            <App />
          </Gate>
        </Router>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
