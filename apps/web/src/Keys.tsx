import { cx } from "./ui";
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/** A key, as it is drawn next to what it does. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-current px-1 font-sans text-[10px] leading-4 font-semibold opacity-60">{children}</kbd>;
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
      ["←  →", "Previous item, next item"], ["X", "Compare: pin this one, the arrow keys change the other"], ["N", "Start a timeline from it"], ["A", "Add to the timeline last added to"], ["S", "Keep / unkeep"], ["Del", "Move to the bin, and go to the next one"], ["D", "Download the file"],
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
  { where: "Viewer (video)", keys: [["C", "Extend: a new clip that carries on from this one"], ["G", "Save frame as an image"], ["T", "Trim: an in and an out on the video, and what to do with the part between"]] },
  {
    where: "Trim (on a video)",
    note: "Pick an in and an out; the actions work on what is between them.",
    keys: [["I  O", "Set in / out at the playhead"], ["←  →", "One frame back / forward (Shift: ten)"], [",  .", "One frame back / forward"], ["L", "Loop the range"], ["Z", "Zoom into the range (the mouse wheel on a strip zooms too)"], ["Space", "Play / pause"], ["Home  End", "Start / end"], ["Esc", "Leave Trim"]],
  },
  {
    where: "Grid, in Studio",
    note: "Selecting several items: to move, keep or bin them together.",
    keys: [
      ["Ctrl + Click", "Select an item (or click the circle on it)"], ["Shift + Click", "Select the range from the last selected item to this one"],
      ["Ctrl + A", "Select all shown"], ["Del", "Move the selection to the bin"], ["Esc", "Clear selection"], ["Right-click", "The menu of the item under the pointer"],
    ],
  },
  {
    where: "Timelines, in Studio",
    keys: [["Click", "Open the timeline"], ["Ctrl + Click", "Select it (Shift + Click: the range)"], ["F2", "Rename the selected timeline"], ["Del", "Delete the selected timelines (the videos stay)"], ["Esc", "Clear selection"], ["Drag", "Onto a folder on the left: the timeline is listed there, its renders land there"], ["Right-click", "Open, rename, put in a folder, move to a project, delete"]],
  },
  { where: "Folders, in Studio", keys: [["Drag", "Items or timelines onto a folder to move them there"], ["Right-click", "Open, a folder inside, rename, rescan (a folder of the disk), delete or unlink"]] },
  { where: "Form, in Studio", keys: [["N", "Open the form, or fold it away to its rail"], ["Ctrl + Enter", "Generate"]] },
  {
    where: "Prompt",
    keys: [["Ctrl + ↑  ↓", "The weight of the tag under the cursor, or of the selection: (red dress:1.1)"], ["{a|b|c}", "Wildcard in the prompt: one option is picked for each output"]],
  },
  { where: "Timeline", keys: [["Space", "Play / pause; with a range, play it, stopping at Out"], ["←  →", "One frame back / forward (Shift: ten)"], [",  .", "One frame back / forward"], ["I  O", "In / Out at the playhead; they snap to cuts, the playhead and quiet moments"], ["Shift + drag", "On the ruler: In and Out in one go"], ["Shift + Click", "On a clip: the range reaches to it"], ["Shift + I  O", "Go to In / Out"], ["L", "Loop the range"], ["Esc", "Clear the range"], ["Del", "Remove the selected clip (Undo brings it back)"], ["Ctrl + Z", "Undo"], ["Ctrl + Shift + Z  Ctrl + Y", "Redo"], ["Ctrl + Click", "On a clip: pick it too; Del removes the picked clips"], ["Ctrl + wheel", "Zoom the track around the pointer; the wheel scrolls it"], ["Right-click", "The menu of the clip under the pointer, of the range, of a clip's audio or of the music"]] },
  {
    where: "Media library, in a timeline",
    note: "The library opened over the stage from the Media tab.",
    keys: [["Click", "Open the item in the viewer"], ["Drag", "Onto the track to place it; onto a clip's first frame, keyframe, last frame, references or voice sample in its form; a sound onto a clip's audio or the music"], ["Right-click", "Use in the selected clip (the last one when none is), place on the timeline, and the item's own actions"], ["Esc", "Fold the library away"]],
  },
  { where: "Queue", keys: [["Drag", "A waiting job up or down to change the order"], ["Right-click", "A waiting job: move it or remove it; the running one: stop it; a finished one: open, requeue, remove"]] },
  { where: "Prompt kit", keys: [["Right-click", "A person, place, style or preset: open, apply the preset in Studio, save it as a file, delete; a snippet: tick, copy its text, delete"]] },
  { where: "Workflows", keys: [["Right-click", "A workflow: try it, edit, export, open in ComfyUI, remove"]] },
  { where: "Menus", keys: [["↑  ↓", "Walk the menu"], ["Enter", "Run the item, or open its submenu"], ["→", "Open the submenu"], ["←", "Back to the menu above"], ["Esc", "Close"]] },
  { where: "Everywhere", keys: [["/  :", "The search nearest the mouse (a form's settings, the library, the Prompt kit, the workflow editor); pressed again inside one, the next"], ["?", "Keyboard shortcuts"], ["Esc", "Close what is open"]] },
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
  const [all, setAll] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      // "?" is Shift with another key on most keyboards: the character is what counts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      const shown = (el: Element) => el.getClientRects().length > 0;
      // "/" pressed inside a search box goes on to the next search box on screen (the shelf's, the form's, the view's), round and round
      const active = document.activeElement;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && active instanceof HTMLInputElement && active.matches("input[data-search]")) {
        const all = [...document.querySelectorAll<HTMLElement>("input[data-search], button[data-search-opener]")].filter(shown);
        const next = all[(all.indexOf(active) + 1) % all.length];
        if (next && next !== active) {
          e.preventDefault();
          if (next instanceof HTMLInputElement) {
            next.focus();
            next.select();
          } else next.click();
        }
        return;
      }
      // "/" goes to the search bar nearest the mouse: the panel under it that has one (a form's own, behind its
      // magnifier; the shelf's; the view's bar); with nothing under the mouse, a form on screen wins, else the view's bar.
      // On AZERTY "/" shares its key with ":": that key works with or without Shift.
      if ((e.key === "/" || e.key === ":") && plainKey(e)) {
        const form = [...document.querySelectorAll<HTMLElement>("input[data-search=form], button[data-search-opener]")].filter(shown)[0];
        const bars = [...document.querySelectorAll<HTMLInputElement>("input[data-search]:not([data-search=form])")].filter(shown);
        const hovered = [...document.querySelectorAll<HTMLElement>(":hover")].at(-1);
        let near: HTMLElement | undefined;
        for (let el: HTMLElement | null = hovered ?? null; el && !near; el = el.parentElement) {
          const inside = [...el.querySelectorAll<HTMLElement>("input[data-search], button[data-search-opener]")].filter(shown);
          if (inside.length) near = inside.find((x) => x.matches("input[data-search=form], button[data-search-opener]")) ?? inside[0];
        }
        const target = near ?? form ?? bars[bars.length - 1];
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
  // the cards that apply to what is on screen: a viewer that is open, a trim bar, the timeline's track, a form, the Studio grid
  const has = (sel: string) => Boolean(document.querySelector(sel));
  const viewer = has('[role=dialog][aria-label="Item"]');
  const onPage = (where: string) => {
    if (where.startsWith("Viewer")) return viewer;
    if (where.startsWith("Trim")) return has('[data-bar="whole"]');
    if (where === "Timeline") return has("[data-designer-floor]");
    if (where.startsWith("Grid")) return (location.pathname === "/" || location.pathname === "/create") && !viewer;
    if (where.startsWith("Media library")) return has("input[data-search=media]");
    if (where.startsWith("Timelines")) return location.pathname.startsWith("/timelines") && !has("[data-designer-floor]") && !viewer;
    if (where.startsWith("Folders")) return (location.pathname === "/" || location.pathname.startsWith("/timelines") || location.pathname === "/create") && !has("[data-designer-floor]") && !viewer;
    if (where === "Queue") return location.pathname.startsWith("/queue");
    if (where === "Workflows") return location.pathname.startsWith("/workflows");
    if (where === "Prompt kit") return location.pathname.startsWith("/kit");
    if (where.startsWith("Form")) return has("input[data-search=form], button[data-search-opener]");
    if (where === "Prompt") return has("textarea");
    return true;
  };
  const shown = all ? KEYS : KEYS.filter((g) => onPage(g.where));
  return (
    <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-keys-help className="fixed inset-0 z-[90] flex items-center justify-center bg-ground/85 p-6" onClick={() => setOpen(false)}>
      <div className="flex max-h-full w-full max-w-[1500px] flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line pr-3 pl-6">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <span className="grow text-ink-2">{all ? "Every screen's keys. They act when the focus is not in a text field." : "The keys of what is on screen now. They act when the focus is not in a text field."}</span>
          <button type="button" aria-pressed={all} onClick={() => setAll((v) => !v)} className={cx("h-8 rounded-lg border px-3 text-xs font-semibold", all ? "border-accent bg-accent-wash text-accent" : "border-line-strong text-ink-2 hover:bg-hover hover:text-ink")}>{all ? "This screen only" : "Every screen"}</button>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </header>
        {/* two wide columns of cards: each row has the keys in a column of one width, and the words beside them on one line or two */}
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto p-5 lg:grid-cols-2">
          {shown.map((group) => (
            <section key={group.where} className="flex flex-col rounded-xl border border-line bg-raised px-4 pt-3.5 pb-1.5">
              <div className="flex flex-col gap-0.5 pb-2">
                <h3 className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{group.where}</h3>
                {group.note && <span className="text-xs text-ink-2">{group.note}</span>}
              </div>
              <dl>
                {group.keys.map(([key, what]) => (
                  <div key={key} className="grid grid-cols-[12rem_minmax(0,1fr)] items-center gap-x-4 border-t border-line/70 py-2 first:border-0">
                    <dt><Caps keys={key} /></dt>
                    <dd className="text-[13px] leading-snug text-ink">{what}</dd>
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
