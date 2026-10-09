import { useEffect, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Dialog, DialogHead } from "./Dialog";
import { Kbd, typing } from "./Keys";
import { useSettings } from "./data";
import { Segmented } from "./ui";

/** Where the list says the command bar's shortcut: the one set in Settings › Command bar is written there. */
const BAR_KEY = "Ctrl + K";

/** Keys held together are written with " + " between them; keys that do the two halves of one thing with two spaces. */
const KEYS: Array<{ where: string; note?: string; keys: Array<[string, string]> }> = [
  {
    where: "Command bar",
    note: "Everything Afflatus holds and does, from any screen. The shortcut can be changed in Settings › Command bar.",
    keys: [
      [BAR_KEY, "Open or close the bar, a text box included"], ["↑  ↓", "Move through the results"], ["PgUp  PgDn", "Eight results up or down"], ["Enter", "The result's first action (open, run, switch)"], ["Ctrl + Enter", "Its second action"],
      ["Tab", "The result's whole list of actions (a command still missing its figures: written in the bar); Tab or Esc goes back"], ["Shift", "Show or hide the preview"], ["Esc", "Clear what is typed, then close"],
      [">  #  /", "Commands · projects and folders · settings"], ["=  !", "The calculator · the queue"], ['"  @', "Prompt history · the cast (each when turned on in Settings › Command bar)"],
    ],
  },
  {
    where: "Viewer (any item)",
    note: "An image, a video or an audio file: opened from the grid, or shown large under \"Draft\".",
    keys: [
      ["←  →", "Previous item, next item"], ["X", "Compare: pin this one, the arrow keys change the other"], ["N", "Start a timeline from it (opened large; under \"Draft\" N folds the form)"], ["A", "Add to the timeline last added to"], ["S", "Keep / unkeep"], ["Del", "Move to the bin, and go to the next one"], ["D", "Download the file"], ["F2", "Rename it"],
      ["L", "Reuse · same seed: open the form with the same generation parameters and seed"], ["Shift + L", "Reuse · new seed: the same generation parameters in the form, with a new seed"], ["V", "Variation: same parameters, new seed, queued at once"],
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
  {
    where: "Projects panel",
    note: "The projects with their folders, timelines and drafts, as a tree: opened from the project button on the rail.",
    keys: [
      ["↑  ↓", "Walk the tree"], ["→  ←", "Open a folder; fold it, or go up to the one it is in"], ["Home  End", "First row, last row"], ["Enter", "Open the row"], ["Space", "Pick it too (as Ctrl + Click)"],
      ["F2", "Rename the row"], ["S", "Keep / unkeep an item"], ["Del", "An item to the bin; anything else asks first"], ["Shift + F10", "The row's menu"], ["Ctrl + F", "Search the tree (or just type)"], ["Esc", "Clear the search, then the picks, then close"],
    ],
  },
  { where: "Folders, in Studio", keys: [["Drag", "Items or timelines onto a folder to move them there"], ["Right-click", "Open, a folder inside, rename, rescan (a folder of the disk), delete or unlink"]] },
  { where: "Form, in Studio", keys: [["N", "Open the form, or fold it away to its rail"], ["Ctrl + Enter", "Generate"]] },
  {
    where: "Prompt",
    keys: [["Ctrl + ↑  ↓", "The weight of the tag under the cursor, or of the selection: (red dress:1.1)"], ["{a|b|c}", "Wildcard in the prompt: one option is picked for each output"], [";", "A snippet of the Prompt kit by name (when turned on in Settings › Command bar): ↑ ↓, then Tab or Enter puts it in"]],
  },
  { where: "Timeline", keys: [["Space", "Play / pause; with a range, play it, stopping at Out"], ["←  →", "One frame back / forward (Shift: ten)"], [",  .", "One frame back / forward"], ["Home  End", "Start / end of the video"], ["I  O", "In / Out at the playhead, exactly (no snapping); alone, In reaches to the end, Out from the start"], ["Shift + drag", "On the ruler: In and Out in one go"], ["Shift + Click", "On a clip: the range reaches to it"], ["Shift + I  O", "Go to In / Out"], ["L", "Loop the range"], ["[  ]", "The clip before / after"], ["Alt + [  ]", "The selected clip plays its previous / next take (stops at the first / last)"], ["S  Ctrl + B", "Split the clip at the playhead: only inside a clip, never on a cut; both halves keep the take, trimmed"], ["Alt + ←  →", "Move the selected clip one place earlier / later (Undo puts it back)"], ["Ctrl + Enter", "Render the selected clip (a new take)"], ["Esc", "Clear the range"], ["Del", "Remove the selected clip (Undo brings it back)"], ["Ctrl + Z", "Undo"], ["Ctrl + Shift + Z  Ctrl + Y", "Redo"], ["Ctrl + Click", "On a clip: pick it too; Del removes the picked clips"], ["-  =", "Zoom the track out / in, around the playhead"], ["Shift + Z", "Fit the whole video"], ["Ctrl + wheel", "Zoom the track around the pointer; the wheel scrolls it"], ["Right-click", "The menu of the clip under the pointer, of the range, of a clip's audio or of the music"]] },
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

/** The cards of a whole screen, put first when it is the one open (Trim goes before the viewer it is in). */
const SCREENS = ["Viewer", "Timeline", "Grid", "Timelines", "Queue", "Workflows", "Prompt kit"];
/** The cards that hold on every screen: after the screen's own. */
const GENERAL = ["Command bar", "Projects panel", "Menus", "Everywhere"];

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

/** The list of keys, opened with "?" from anywhere (or the strip's Shortcuts button): every place of the app as a card, side by side. */
export function KeysHelp() {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  // "Ctrl+K" as the list writes keys: "Ctrl + K"
  const barKey = (useSettings().data?.bar?.shortcut ?? "Ctrl+K").split("+").join(" + ");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "?" is Shift with another key on most keyboards: the character is what counts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
        e.preventDefault();
        setOpen((o) => !o);
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
    // the rest hold on every screen: the Projects panel among them (the rail's project button opens it anywhere; while it is open, "?" types in its search)
    return true;
  };
  // the screen's own card first (Trim over the viewer it is in), then the parts of it, then what works everywhere; every screen: the rest after
  const rank = (where: string) => (where.startsWith("Trim") ? 0 : SCREENS.some((s) => where.startsWith(s)) ? 1 : GENERAL.includes(where) ? 3 : 2);
  const here = KEYS.filter((g) => onPage(g.where)).sort((a, b) => rank(a.where) - rank(b.where));
  const shown = all ? [...here, ...KEYS.filter((g) => !here.includes(g))] : here;
  return (
    <Dialog label="Keyboard shortcuts" onClose={() => setOpen(false)} z="z-[90]" className="flex max-h-full w-full max-w-[1500px] flex-col rounded-[18px] border border-line-strong bg-panel shadow-2xl shadow-shade/60 motion-safe:animate-[peek-rise_120ms_ease-out]">
        {/* the head, with the switch between it and the way out */}
        <header data-keys-help className="flex shrink-0 items-center gap-2.5 border-b border-line px-5 py-3.5">
          <span className="min-w-0 grow">
            <DialogHead icon={<Keyboard size={16} />} title="Keyboard shortcuts" sub={all ? "Every screen's keys. They act when the focus is not in a text field." : "The keys of what is on screen now. They act when the focus is not in a text field."} />
          </span>
          <Segmented size="sm" oneLine label="Which keys" value={all ? "all" : "here"} onChange={(v) => setAll(v === "all")} options={[{ value: "here", label: "This screen" }, { value: "all", label: "Every screen" }]} />
          <Kbd>Esc</Kbd>
          <button type="button" aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={() => setOpen(false)} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
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
                    <dt><Caps keys={key === BAR_KEY ? barKey : key} /></dt>
                    <dd className="text-[13px] leading-snug text-ink">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
    </Dialog>
  );
}
