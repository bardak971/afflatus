import { useEffect, useRef, useState } from "react";
import { copyText } from "../../secureContext";

/**
 * A copy from a menu, which closes as it is clicked: a word on how it went is shown for a moment where the copied
 * text was ("Copied", or that the browser refused, as the command bar says it), since nothing else would say it.
 */
export function useCopyNote(): { note: { ok: boolean; text: string } | null; copy(text: string): void } {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = (ok: boolean) => {
    setNote({ ok, text: ok ? "Copied" : "Could not copy: the browser refused" });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), ok ? 1500 : 4000);
  };
  return { note, copy: (text) => void copyText(text).then(() => say(true), () => say(false)) };
}
