import { lazy, Suspense, useEffect, useState } from "react";
import { useSettings } from "../data";
import { isShortcut, useBar } from "./store";

// the bar is a chunk of its own, fetched once the app is idle: the first Ctrl+K never waits for it
const load = () => import("./CommandBar");
const CommandBar = lazy(() => load().then((m) => ({ default: m.CommandBar })));

/**
 * Where the command bar lives in the app: its shortcut, heard from anywhere (a text box included), and the
 * bar itself once it was first opened. Mounted once, by the app.
 */
export function BarHost() {
  const shortcut = useSettings().data?.bar?.shortcut ?? "Ctrl+K";
  const open = useBar((s) => s.open);
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isShortcut(e, shortcut)) return;
      // the settings page records a new shortcut with its own keys
      if ((e.target as Element | null)?.closest?.("[data-shortcut-recorder]")) return;
      e.preventDefault();
      e.stopPropagation();
      const bar = useBar.getState();
      if (bar.open) bar.hide();
      else bar.show();
    };
    // the capture phase: before a text box, a dialog or a screen's own keys take it
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcut]);

  // fetched while nothing else happens, once the page has settled, and mounted closed: its index is read then, so
  // that the first opening draws at once
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => void load().then(() => setWanted(true), () => {}), { timeout: 4000 } as IdleRequestOptions);
    return () => cancel(id);
  }, []);

  // another part of the app opens it (the keys list, a button): `afflatus:bar` with what to start typed
  useEffect(() => {
    const on = (e: Event) => useBar.getState().show((e as CustomEvent<{ seed?: string }>).detail?.seed ?? "");
    window.addEventListener("afflatus:bar", on);
    return () => window.removeEventListener("afflatus:bar", on);
  }, []);

  return wanted ? <Suspense fallback={null}><CommandBar /></Suspense> : null;
}
