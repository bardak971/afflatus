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
    where: "Viewer (any item)",
    note: "An image, a video or an audio file: opened from the grid, or shown large under \"This draft\".",
    keys: [
      ["←  →", "Previous item, next item"], ["S", "Keep / unkeep"], ["Del", "Move to the bin, and go to the next one"], ["D", "Download the file"],
      ["L", "Reuse parameters: open the form with the same generation parameters"], ["V", "Variation: same parameters, new seed, queued at once"],
      ["Esc", "Close"],
    ],
  },
  {
    where: "Viewer (image)",
    note: "What is queued at once uses the model the image was generated with, and its generation parameters.",
    keys: [
      ["U", "Upscale 2x, queued at once"], ["F", "Face detailer, queued at once"], ["B", "Remove background, queued at once"],
      ["I", "Inpaint: a new draft in the form"], ["E", "Edit / img2img: a new draft in the form"], ["R", "Outpaint to another aspect ratio: a new draft in the form"],
      ["M", "Image to video (i2v)"], ["P", "PNG info (for an imported file)"],
    ],
  },
  { where: "Viewer (video)", keys: [["C", "Extend: a new clip that carries on from this one"], ["G", "Save frame as an image"], ["T", "Trim: in / out on the video, then copy, split, remove, generate between"]] },
  {
    where: "Trim (on a video)",
    note: "Pick an in and an out; the actions work on what is between them.",
    keys: [["I  O", "Set in / out at the playhead"], [",  .", "One frame back / forward (Shift: ten)"], ["L", "Loop the range"], ["Z", "Zoom into the range (the mouse wheel on a strip zooms too)"], ["Space", "Play / pause"], ["Home  End", "Start / end"], ["Esc", "Leave Trim"]],
  },
  {
    where: "Grid, in Studio",
    note: "Selecting several items: to move, keep or bin them together.",
    keys: [
      ["Ctrl + Click", "Select an item (or click the circle on it)"], ["Shift + Click", "Select the range from the last selected item to this one"],
      ["Ctrl + A", "Select all shown"], ["Del", "Move the selection to the bin"], ["Esc", "Clear selection"], ["Right-click", "Menu of an item: open, keep, i2v, reuse parameters, variation, Open in ComfyUI, download, bin"],
    ],
  },
  { where: "Form, in Studio", keys: [["Ctrl + Enter", "Generate"]] },
  {
    where: "Prompt",
    keys: [["Ctrl + ↑  ↓", "Prompt weight of the tag under the cursor, or of the selection: (red dress:1.1)"], ["{a|b|c}", "Wildcard in the prompt: one option is picked for each output"]],
  },
  { where: "Timeline", keys: [["Space", "Play / pause"], ["Del", "Remove the selected clip (Undo brings it back)"], ["Ctrl + Z", "Undo"], ["←  →", "Move the playhead, when the track has focus"], ["T", "Trim the selected clip: play range, split here, regenerate a part"], ["Right-click", "Menu of a clip: render / new take, extend, trim, open its video, mute, remove"]] },
  { where: "Everywhere", keys: [["/  :", "Find a setting in the open form; else the search bar of the view (library, Prompt kit, snippets, workflow editor)"], ["?", "Keyboard shortcuts"], ["Esc", "Close what is open"]] },
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
      // "/" goes to the search bar of the view: the one on top when a panel with its own is open.
      // On AZERTY "/" shares its key with ":": that key works with or without Shift.
      if ((e.key === "/" || e.key === ":") && plainKey(e)) {
        const shown = (el: Element) => el.getClientRects().length > 0;
        // a form on screen has a search of its own (behind its magnifier): that one, wherever the mouse is; else the view's bar
        const form = [...document.querySelectorAll<HTMLElement>("input[data-search=form], button[data-search-opener]")].filter(shown)[0];
        const bars = [...document.querySelectorAll<HTMLInputElement>("input[data-search]:not([data-search=form])")].filter(shown);
        const target = form ?? bars[bars.length - 1];
        if (target) {
          e.preventDefault();
          if (target instanceof HTMLInputElement) {
            target.focus();
            target.select();
          } else {
            target.click();
          }
        }
      }
    };
    const onAsk = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("afflatus:keys", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("afflatus:keys", onAsk);
    };
  }, []);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-keys-help className="fixed inset-0 z-[90] flex items-center justify-center bg-ground/85 p-6" onClick={() => setOpen(false)}>
      <div className="flex max-h-full w-full max-w-[1500px] flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line pr-3 pl-6">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <span className="grow text-ink-2">They act when the focus is not in a text field.</span>
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
