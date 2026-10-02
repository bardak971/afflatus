import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/** A key, as it is drawn next to what it does. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong px-1 font-mono text-[10px] leading-4 font-normal text-ink-2">{children}</kbd>;
}

/** The key was pressed in a box being typed in. */
const typing = (e: KeyboardEvent) => {
  const el = e.target as Partial<HTMLElement> | null;
  return typeof el?.closest === "function" && Boolean(el.closest("input, textarea, select, [contenteditable]"));
};

/**
 * A key press meant for the app, not for a box being typed in, a list that is open, or a dialog on top
 * of what the keys belong to. Keys held with Ctrl, Alt or the command key are the browser's.
 */
export function plainKey(e: KeyboardEvent, opts: { over?: string } = {}): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (typing(e)) return false;
  // an open dropdown, or a dialog over the one the keys are for
  if (document.querySelector("[role=listbox], [role=menu]")) return false;
  if (opts.over && document.querySelector(opts.over)) return false;
  return true;
}

const KEYS: Array<{ where: string; keys: Array<[string, string]> }> = [
  {
    where: "An item that is open (a picture, a video, a sound)",
    keys: [
      ["←  →", "The item before, the item after"], ["S", "Keep it, or stop keeping it"], ["Del", "Move it to the bin, and go to the next one"], ["D", "Download the file"],
      ["L", "Load its settings into the form (make more like it)"], ["V", "Variation: the same settings with a new seed, queued at once"],
      ["Esc", "Close"],
    ],
  },
  {
    where: "A picture that is open",
    keys: [
      ["U", "Upscale 2x, queued at once"], ["F", "Face detailer, queued at once"], ["B", "Remove the background, queued at once"],
      ["I", "Inpaint: open it in the form"], ["E", "Edit / img2img: open it in the form"], ["R", "Outpaint to another aspect ratio: open it in the form"],
      ["M", "Make a video from it"], ["P", "PNG info (for a file that was brought in)"],
    ],
  },
  { where: "A video that is open", keys: [["C", "Continue it in a new clip"], ["G", "Save the frame shown as a picture"]] },
  { where: "The form, in Studio", keys: [["Ctrl + Enter", "Make"]] },
  { where: "A prompt", keys: [["Ctrl + ↑  ↓", "The weight of the tag the cursor is in, or of what is selected: (red dress:1.1)"], ["{a|b|c}", "Written in the text: one of the choices is picked for each result"]] },
  { where: "A timeline", keys: [["Space", "Play or pause"], ["Del", "Remove the selected clip (Undo brings it back)"], ["Ctrl + Z", "Undo"], ["←  →", "Move the playhead, when the track has the focus"]] },
  { where: "Everywhere", keys: [["?", "This list"], ["Esc", "Close what is open"]] },
];

/** The list of keys, opened with "?" from anywhere. */
export function KeysHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      // "?" is Shift with another key on most keyboards: the character is what counts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onAsk = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("studai:keys", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("studai:keys", onAsk);
    };
  }, []);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Keys" data-keys-help className="fixed inset-0 z-[90] flex items-center justify-center bg-ground/85 p-8" onClick={() => setOpen(false)}>
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-14 shrink-0 items-center border-b border-line pr-3 pl-5">
          <h2 className="grow text-base font-semibold">Keys</h2>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <span className="text-ink-2">Keys act when you are not typing in a box. A key that queues something at once uses the model the picture was made with, and its settings.</span>
          {KEYS.map((group) => (
            <div key={group.where} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink-2">{group.where}</span>
              <dl className="grid grid-cols-[110px_1fr] items-baseline gap-x-3 gap-y-1">
                {group.keys.map(([key, what]) => (
                  <div key={key} className="contents">
                    <dt><Kbd>{key}</Kbd></dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
