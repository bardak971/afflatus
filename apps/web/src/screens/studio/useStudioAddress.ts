import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { plainKey } from "../../Keys";
import { useStudio } from "../../store";

/**
 * The form's key and address: N opens the form, or folds it away, from anywhere on the screen (not while typing); and the
 * address follows the form, "/create" while it is open, "/" while it is closed, so a reload or a link keeps it (store.ts
 * reads it when the app loads). Opening and closing replace the address, no history entry per toggle. A link to
 * "/create" opens the form (`forced`); "/" with the form open (a way in that opened it, then went to the Studio) takes
 * the form's address. The timelines' Studio keeps its own address.
 */
export function useStudioAddress({ forced, onTimelines }: { forced?: boolean; onTimelines?: boolean }) {
  const view = useStudio();
  const [, go] = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey || !plainKey(e) || document.querySelector("[role=dialog][aria-modal=true]")) return;
      e.preventDefault();
      useStudio.getState().set({ form: !useStudio.getState().form });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const formWas = useRef<boolean | null>(null);
  useEffect(() => {
    if (onTimelines) return;
    const toggled = formWas.current !== null && formWas.current !== view.form;
    formWas.current = view.form;
    if (Boolean(forced) === view.form) return;
    if (toggled) go(view.form ? "/create" : "/", { replace: true });
    else if (forced) view.set({ form: true });
    else go("/create", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the form and the address only; go and view are new at every render
  }, [view.form, forced, onTimelines]);
}
