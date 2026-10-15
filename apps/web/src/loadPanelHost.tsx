import { lazy, Suspense, useEffect, useState } from "react";

/** Asked by the menus and the command bar ("Load a model…"): the dialog opens, on the machine named when there is one. */
const OPEN_LOAD = "afflatus:load-model";
export const openLoadPanel = (machine?: string) => window.dispatchEvent(new CustomEvent(OPEN_LOAD, { detail: { machine } }));

// the dialog and what it lists (loadChoices.ts) are a chunk of their own, fetched the first time it opens
const LoadDialog = lazy(() => import("./LoadPanel").then((m) => ({ default: m.LoadDialog })));

/** "Load a model…" (LoadPanel.tsx), mounted once (StatusBar.tsx) and opened from the menus and the command bar. */
export function LoadPanelHost() {
  const [open, setOpen] = useState<{ machine?: string } | null>(null);
  useEffect(() => {
    const show = (e: Event) => setOpen({ machine: (e as CustomEvent<{ machine?: string }>).detail?.machine });
    window.addEventListener(OPEN_LOAD, show);
    return () => window.removeEventListener(OPEN_LOAD, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LoadDialog machine={open.machine} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
