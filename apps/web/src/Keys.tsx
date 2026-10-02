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

/** Keys held together are written with " + " between them; keys that do the two halves of one thing with two spaces. */
const KEYS: Array<{ where: string; note?: string; keys: Array<[string, string]> }> = [
  {
    where: "An item that is open",
    note: "A picture, a video or a sound: opened from the grid, or shown large under \"This draft\".",
    keys: [
      ["←  →", "The item before, the item after"], ["S", "Keep it, or stop keeping it"], ["Del", "Move it to the bin, and go to the next one"], ["D", "Download the file"],
      ["L", "Load its settings into the form (make more like it)"], ["V", "Variation: the same settings with a new seed, queued at once"],
      ["Esc", "Close"],
    ],
  },
  {
    where: "A picture that is open",
    note: "What is queued at once uses the model the picture was made with, and its settings.",
    keys: [
      ["U", "Upscale 2x, queued at once"], ["F", "Face detailer, queued at once"], ["B", "Remove the background, queued at once"],
      ["I", "Inpaint: a new draft in the form"], ["E", "Edit / img2img: a new draft in the form"], ["R", "Outpaint to another aspect ratio: a new draft in the form"],
      ["M", "Make a video from it"], ["P", "PNG info (for a file that was brought in)"],
    ],
  },
  { where: "A video that is open", keys: [["C", "Continue it in a new clip"], ["G", "Save the frame shown as a picture"]] },
  {
    where: "The grid, in Studio",
    note: "Ticking several items: to move, keep or delete them together.",
    keys: [
      ["Ctrl + Click", "Tick an item (or click the circle on it)"], ["Shift + Click", "Tick everything from the last one ticked to this one"],
      ["Ctrl + A", "Tick everything shown"], ["Del", "Send what is ticked to the bin"], ["Esc", "Untick everything"],
    ],
  },
  { where: "The form, in Studio", keys: [["Ctrl + Enter", "Make"]] },
  {
    where: "A prompt",
    keys: [["Ctrl + ↑  ↓", "The weight of the tag the cursor is in, or of what is selected: (red dress:1.1)"], ["{a|b|c}", "Written in the text: one of the choices is picked for each result"]],
  },
  { where: "A timeline", keys: [["Space", "Play or pause"], ["Del", "Remove the selected clip (Undo brings it back)"], ["Ctrl + Z", "Undo"], ["←  →", "Move the playhead, when the track has the focus"]] },
  { where: "Everywhere", keys: [["?", "This list"], ["Esc", "Close what is open"]] },
];

/** A key as a cap, as on a keyboard. */
const cap = "inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-line-strong bg-ground px-2 font-mono text-xs text-ink shadow-[inset_0_-2px_0_var(--color-line)]";

/** "Ctrl + ↑  ↓" as caps: Ctrl, a plus, then the two arrows side by side. */
function Caps({ keys }: { keys: string }) {
  const held = keys.split(" + ");
  return (
    <span className="flex flex-wrap items-center gap-1">
      {held.map((group, i) => (
        <span key={group} className="flex items-center gap-1">
          {i > 0 && <span className="text-ink-3">+</span>}
          {group.split(/\s{2,}/).map((k) => <kbd key={k} className={cap}>{k}</kbd>)}
        </span>
      ))}
    </span>
  );
}

/** The list of keys, opened with "?" from anywhere: every place of the app as a card, side by side. */
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
    <div role="dialog" aria-modal="true" aria-label="Keys" data-keys-help className="fixed inset-0 z-[90] flex items-center justify-center bg-ground/85 p-6" onClick={() => setOpen(false)}>
      <div className="flex max-h-full w-full max-w-[1500px] flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line pr-3 pl-6">
          <h2 className="text-lg font-semibold">Keys</h2>
          <span className="grow text-ink-2">They act when you are not typing in a box.</span>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </header>
        {/* cards that fill columns one after the other: as many columns as the window has room for */}
        <div className="min-h-0 columns-1 gap-4 overflow-y-auto p-5 md:columns-2 xl:columns-3 2xl:columns-4">
          {KEYS.map((group) => (
            <section key={group.where} className="mb-3.5 flex break-inside-avoid flex-col gap-2.5 rounded-xl border border-line bg-raised p-3.5">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-semibold">{group.where}</h3>
                {group.note && <span className="text-xs text-ink-2">{group.note}</span>}
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-1.5">
                {group.keys.map(([key, what]) => (
                  <div key={key} className="contents">
                    <dt><Caps keys={key} /></dt>
                    <dd className="text-ink-2">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
