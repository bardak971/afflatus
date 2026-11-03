import { useFlash } from "../../hooks";
import { copyText } from "../../secureContext";

/**
 * A copy from a menu, which closes as it is clicked: a word on how it went is shown for a moment where the copied
 * text was ("Copied", or that the browser refused, as the command bar says it, left longer to be read), since nothing
 * else would say it.
 */
export function useCopyNote(): { note: { ok: boolean; text: string } | null; copy(text: string): void } {
  const [note, flash] = useFlash<{ ok: boolean; text: string } | null>(null);
  return {
    note,
    copy: (text) => void copyText(text).then(() => flash({ ok: true, text: "Copied" }), () => flash({ ok: false, text: "Could not copy: the browser refused" }, 4000)),
  };
}
