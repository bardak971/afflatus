/**
 * Every key of the app, by the place it acts in: read by the sheet ("?"), and checked by a test against the menus'
 * and the tips' keys. The keys are written with the grammar of `grammar.ts` ("Ctrl+Shift+Z | Ctrl+Y", "← →").
 * Each row was read off its handler; when a handler changes, its row changes with it.
 */

export interface KeyRow {
  /** The keys, in the grammar. */
  keys: string;
  /** What they do, in a few words. */
  does: string;
  /** When or where, short: drawn dimmer after what it does. */
  note?: string;
  /** A mouse move: listed last, as text. */
  mouse?: true;
  /** The command bar's own shortcut: the one set in Settings › Command bar is drawn in place of `keys`. */
  bar?: true;
  /** A name the rest of the app reads the row by (the command bar's rows show its keys): never a second copy of a chord. */
  id?: RowId;
}

/** The rows read by name elsewhere (`rowKeys`). */
export type RowId = "keys" | "generate" | "split" | "take" | "render-clip";

export interface KeyGroup {
  name: string;
  /** Only for this kind of item (the viewer's image and video keys). */
  kind?: "image" | "video";
  rows: KeyRow[];
}

export type PlaceId = "everywhere" | "bar" | "menus" | "grid" | "timelines" | "form" | "viewer" | "trim" | "editor" | "media" | "projects" | "queue" | "mask" | "kit";

export interface KeyPlace {
  id: PlaceId;
  name: string;
  /** One line under the place's name. */
  about?: string;
  groups: KeyGroup[];
}

/** The command bar's shortcut until the settings say another. */
export const BAR_DEFAULT = "Ctrl+K";

export const PLACES: KeyPlace[] = [
  {
    id: "everywhere",
    name: "Everywhere",
    about: "act when no text box has the focus",
    groups: [
      {
        name: "Anywhere",
        rows: [
          { keys: BAR_DEFAULT, does: "Command bar", note: "a text box included; set in Settings › Command bar", bar: true },
          { keys: "/ | :", does: "Search nearest the mouse", note: "pressed again inside one: the next search" },
          { keys: "?", does: "Keyboard shortcuts", id: "keys" },
          { keys: "Esc", does: "Close what is open on top" },
          { keys: "Menu | Shift+F10", does: "Menu of what has the focus" },
        ],
      },
    ],
  },
  {
    id: "bar",
    name: "Command bar",
    about: "everything Afflatus holds and does, from any screen",
    groups: [
      {
        name: "Results",
        rows: [
          { keys: BAR_DEFAULT, does: "Open or close the bar", bar: true },
          { keys: "↑ ↓", does: "Move through the results" },
          { keys: "PgUp PgDn", does: "Eight results up / down" },
          { keys: "Enter", does: "The result's first action", note: "open, run, switch" },
          { keys: "Ctrl+Enter", does: "Its second action" },
          { keys: "Tab", does: "All the result's actions", note: "Tab or Esc goes back" },
          { keys: "Shift", does: "Show or hide the preview", note: "pressed alone" },
          { keys: "Esc", does: "Clear what is typed, then close" },
        ],
      },
      {
        name: "Modes",
        rows: [
          { keys: ">", does: "Commands" },
          { keys: "#", does: "Places", note: "projects and folders" },
          { keys: "/", does: "Settings" },
          { keys: "=", does: "Calculator" },
          { keys: "!", does: "Queue" },
          { keys: "?", does: "Keys", note: "the rows of this sheet; Enter opens it on one" },
          { keys: '"', does: "Prompt history", note: "when turned on in Settings › Command bar" },
          { keys: "@", does: "Cast", note: "when turned on in Settings › Command bar" },
        ],
      },
    ],
  },
  {
    id: "menus",
    name: "Menus",
    about: "a right-click menu, or one opened from the keyboard",
    groups: [
      {
        name: "Menu",
        rows: [
          { keys: "↑ ↓", does: "Walk the menu" },
          { keys: "Enter", does: "Run the item, or open its submenu" },
          { keys: "→", does: "Open the submenu" },
          { keys: "←", does: "Back to the menu above" },
          { keys: "Esc", does: "Close", note: "a submenu: back to the one above" },
        ],
      },
    ],
  },
  {
    id: "grid",
    name: "Studio grid",
    about: "ticking items, to move, keep or bin them together",
    groups: [
      {
        name: "Selection",
        rows: [
          { keys: "Ctrl+A", does: "Select all shown" },
          { keys: "Del", does: "Move the ticked items to the bin" },
          { keys: "Esc", does: "Clear the selection" },
          { keys: "Space | Enter", does: "Tick the item", note: "on its circle; with Shift: the range" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "click", does: "Open in the viewer", note: "once anything is ticked: tick it", mouse: true },
          { keys: "Ctrl+click", does: "Tick an item", note: "or click its circle", mouse: true },
          { keys: "Shift+click", does: "Tick the range from the last ticked", mouse: true },
          { keys: "drag", does: "Onto a folder: move it there", mouse: true },
          { keys: "right-click", does: "The item's menu", note: "a folder's: open, rename, rescan, delete", mouse: true },
        ],
      },
    ],
  },
  {
    id: "timelines",
    name: "Timelines list",
    about: "the timelines, in Studio",
    groups: [
      {
        name: "Timelines",
        rows: [
          { keys: "Enter", does: "Open the timeline", note: "on its card" },
          { keys: "Space | Enter", does: "Tick it", note: "on its circle" },
          { keys: "F2", does: "Rename the ticked timeline" },
          { keys: "Del | Backspace", does: "Delete the ticked timelines", note: "asks first; the videos stay" },
          { keys: "Esc", does: "Clear the selection" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "click", does: "Open the timeline", note: "once one is ticked: tick it", mouse: true },
          { keys: "Ctrl+click", does: "Tick it", mouse: true },
          { keys: "Shift+click", does: "Tick the range", mouse: true },
          { keys: "drag", does: "Onto a folder: list it there", note: "its renders land there", mouse: true },
          { keys: "right-click", does: "Open, rename, folder, project, delete", mouse: true },
        ],
      },
    ],
  },
  {
    id: "form",
    name: "Form and prompt",
    about: "the Studio's form, a clip's form, the prompt boxes",
    groups: [
      {
        name: "Form",
        rows: [
          { keys: "N", does: "Open the form, or fold it to its rail", note: "Studio and the timelines list" },
          { keys: "Ctrl+Enter", does: "Generate", note: "in a timeline: render the selected clip", id: "generate" },
        ],
      },
      {
        name: "Prompt",
        rows: [
          { keys: "Ctrl+↑ Ctrl+↓", does: "Weight of the tag under the cursor", note: "or the selection: (red dress:1.1)" },
          { keys: "{a|b|c}", does: "Wildcard: one option per output" },
        ],
      },
      {
        name: "Snippets by name",
        rows: [
          { keys: ";", does: "Snippet by name", note: "when turned on in Settings › Command bar" },
          { keys: "↑ ↓", does: "Choose in the list" },
          { keys: "Tab | Enter", does: "Put it in" },
          { keys: "Space | Tab", does: "Put it in, the whole name typed" },
          { keys: "Esc", does: "Close the list" },
        ],
      },
      {
        name: "Designer",
        rows: [
          { keys: "Enter", does: "Send the message" },
          { keys: "Shift+Enter", does: "New line" },
          { keys: "Esc", does: "Close the designer" },
        ],
      },
    ],
  },
  {
    id: "viewer",
    name: "Viewer",
    about: "an image, a video or a sound, opened large or under Draft; in the bin only ← →, X, D and Esc act",
    groups: [
      {
        name: "Any item",
        rows: [
          { keys: "← →", does: "Previous / next item", note: "comparing: the other one" },
          { keys: "X", does: "Compare: pin this one", note: "the arrows change the other" },
          { keys: "S", does: "Keep / unkeep" },
          { keys: "Del", does: "Move to the bin, go to the next" },
          { keys: "D", does: "Download", note: "in the bin too" },
          { keys: "F2", does: "Rename", note: "opened large" },
          { keys: "N", does: "Start a timeline from it", note: "opened large; under Draft N folds the form" },
          { keys: "A", does: "Add to the timeline last added to" },
          { keys: "L", does: "Reuse · same seed", note: "the form, same parameters and seed" },
          { keys: "Shift+L", does: "Reuse · new seed" },
          { keys: "V", does: "Variation", note: "same parameters, new seed, queued" },
          { keys: "P", does: "Details", note: "its parameters; for a file made elsewhere, PNG info" },
          { keys: "Esc", does: "Stop comparing, then close" },
        ],
      },
      {
        name: "Image",
        kind: "image",
        rows: [
          { keys: "U", does: "Upscale 2x", note: "queued at once" },
          { keys: "F", does: "Face detailer", note: "queued at once" },
          { keys: "B", does: "Remove background", note: "queued at once" },
          { keys: "I", does: "Inpaint…", note: "a new draft, the mask painter open" },
          { keys: "E", does: "Edit…", note: "img2img: a new draft in the form" },
          { keys: "R", does: "Outpaint…", note: "a new draft in the form" },
          { keys: "M", does: "Image to video (i2v)" },
        ],
      },
      {
        name: "Video",
        kind: "video",
        rows: [
          { keys: "C", does: "Extend", note: "a new clip carrying on from this one" },
          { keys: "G", does: "Save frame", note: "the one it is paused on, as a picture" },
          { keys: "T", does: "Trim" },
        ],
      },
      {
        name: "Compare",
        rows: [
          { keys: "← →", does: "Move the wipe", note: "its handle focused; Shift: ten" },
          { keys: "Home End", does: "Wipe all one side", note: "its handle focused" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "drag", does: "The item out: onto a folder, a form, a timeline", mouse: true },
          { keys: "right-click", does: "The item's menu", mouse: true },
        ],
      },
    ],
  },
  {
    id: "trim",
    name: "Trim",
    about: "an in and an out on a video; the actions work between them",
    groups: [
      {
        name: "Range",
        rows: [
          { keys: "I O", does: "In / Out at the playhead" },
          { keys: "L", does: "Loop the range" },
          { keys: "Z", does: "Zoom into the range", note: "again: the whole video" },
        ],
      },
      {
        name: "Play",
        rows: [
          { keys: "Space", does: "Play / pause" },
          { keys: "← →", does: "Frame back / forward" },
          { keys: "Shift+← Shift+→", does: "Ten frames" },
          { keys: ", . | < >", does: "Frame back / forward", note: "no Shift" },
          { keys: "Home End", does: "Start / end" },
          { keys: "Esc", does: "Leave Trim" },
        ],
      },
      {
        name: "With the mouse",
        rows: [{ keys: "wheel", does: "Zoom a strip", mouse: true }],
      },
    ],
  },
  {
    id: "editor",
    name: "Timeline editor",
    about: "act when no text box has the focus",
    groups: [
      {
        name: "Play",
        rows: [
          { keys: "Space", does: "Play / pause", note: "a range plays to Out" },
          { keys: "← → | , .", does: "Frame back / forward" },
          { keys: "Shift+← Shift+→", does: "Ten frames" },
          { keys: "Home End", does: "Start / end" },
          { keys: "[ ]", does: "Clip before / after" },
        ],
      },
      {
        name: "Range",
        rows: [
          { keys: "I O", does: "In / Out at the playhead", note: "alone, In reaches to the end" },
          { keys: "Shift+I Shift+O", does: "Go to In / Out" },
          { keys: "L", does: "Loop the range" },
          { keys: "Esc", does: "Clear the picks and the range", note: "then the clip's panel, then the music's" },
        ],
      },
      {
        name: "Clips",
        rows: [
          { keys: "Enter | Space", does: "Open the clip", note: "the clip focused" },
          { keys: "S | Ctrl+B", does: "Split at the playhead", note: "inside a clip", id: "split" },
          { keys: "Alt+[ Alt+]", does: "Previous / next take", id: "take" },
          { keys: "Alt+← Alt+→", does: "Move one place earlier / later" },
          { keys: "Ctrl+Enter", does: "Render the selected clip", note: "a new take", id: "render-clip" },
          { keys: "Del", does: "Remove", note: "the picked ones too" },
        ],
      },
      {
        name: "Edit",
        rows: [
          { keys: "Ctrl+Z", does: "Undo" },
          { keys: "Ctrl+Shift+Z | Ctrl+Y", does: "Redo" },
        ],
      },
      {
        name: "Zoom",
        rows: [
          { keys: "- =", does: "Zoom the track out / in", note: "+ zooms in too" },
          { keys: "Shift+Z", does: "Fit the whole video" },
        ],
      },
      {
        name: "Strips",
        rows: [
          { keys: "← →", does: "Move the music's start", note: "its strip in the inspector focused; Shift: one second" },
          { keys: "← →", does: "Seek one second", note: "the full-screen strip focused; Shift: five" },
          { keys: "Enter | Space", does: "The music under a clip", note: "its block focused" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "Ctrl+click", does: "Pick a clip too", note: "for a render or Del of several", mouse: true },
          { keys: "Shift+click", does: "Range to a clip", mouse: true },
          { keys: "Shift+drag", does: "In and Out on the ruler", mouse: true },
          { keys: "Ctrl+wheel", does: "Zoom around the pointer", note: "the wheel scrolls", mouse: true },
          { keys: "right-click", does: "Clip, range, audio or music menu", mouse: true },
        ],
      },
    ],
  },
  {
    id: "media",
    name: "Media library",
    about: "the library over a timeline's stage, from the Media tab",
    groups: [
      { name: "Library", rows: [{ keys: "Esc", does: "Fold the library away" }] },
      {
        name: "With the mouse",
        rows: [
          { keys: "click", does: "Open the item in the viewer", mouse: true },
          { keys: "drag", does: "Onto the track, a clip's form, its audio or the music", mouse: true },
          { keys: "right-click", does: "Use in the selected clip, place on the timeline", mouse: true },
        ],
      },
    ],
  },
  {
    id: "projects",
    name: "Projects panel",
    about: "projects, folders, timelines and drafts as a tree, from the rail's project button",
    groups: [
      {
        name: "Tree",
        rows: [
          { keys: "↑ ↓", does: "Walk the tree" },
          { keys: "→ ←", does: "Open a folder / fold it, or go up" },
          { keys: "Home End", does: "First row / last row" },
          { keys: "Enter", does: "Open the row" },
          { keys: "Space", does: "Pick it too", note: "as Ctrl+click" },
          { keys: "Shift+Enter", does: "Pick the range to it" },
        ],
      },
      {
        name: "Pinned projects",
        rows: [
          { keys: "Alt+↑ Alt+↓", does: "Move a pin up / down", note: "a rail pin focused" },
        ],
      },
      {
        name: "Rows",
        rows: [
          { keys: "F2", does: "Rename the row" },
          { keys: "S", does: "Keep / unkeep an item" },
          { keys: "Del | Backspace", does: "Items to the bin", note: "anything else asks first" },
          { keys: "Menu | Shift+F10", does: "The row's menu" },
          { keys: "Ctrl+F", does: "Search the tree", note: "or just type" },
          { keys: "Esc", does: "Stop renaming, clear the search, the picks, then close" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "Ctrl+click", does: "Pick a row too", mouse: true },
          { keys: "Shift+click", does: "Pick the range", mouse: true },
          { keys: "drag", does: "Rows onto a project or a folder", mouse: true },
        ],
      },
    ],
  },
  {
    id: "queue",
    name: "Queue",
    groups: [
      {
        name: "Jobs",
        rows: [
          { keys: "Del", does: "Remove a waiting job", note: "its row focused" },
          { keys: "Enter | Space", does: "Show / hide a failed job's error", note: "its row focused" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "drag", does: "A waiting job up or down", mouse: true },
          { keys: "right-click", does: "Run next, remove; stop the running one; requeue a finished one", mouse: true },
        ],
      },
    ],
  },
  {
    id: "mask",
    name: "Mask painter",
    groups: [
      {
        name: "Painting",
        rows: [
          { keys: "Ctrl+Z", does: "Undo the last stroke" },
          { keys: "Space", does: "Move the picture", note: "hold" },
          { keys: "Esc", does: "Close" },
        ],
      },
      { name: "With the mouse", rows: [{ keys: "wheel", does: "Zoom around the pointer", mouse: true }] },
    ],
  },
  {
    id: "kit",
    name: "Prompt kit · Workflows",
    groups: [
      { name: "A person", rows: [{ keys: "Alt+← Alt+→", does: "Move a picture earlier / later", note: "the picture focused" }] },
      {
        name: "A workflow's form",
        rows: [
          { keys: "Alt+← Alt+→", does: "A field earlier / later in its group" },
          { keys: "Alt+↑ Alt+↓", does: "A field to the section above / below" },
          { keys: "Alt+↑ Alt+↓", does: "Move a section up / down", note: "its card focused" },
        ],
      },
      {
        name: "With the mouse",
        rows: [
          { keys: "right-click", does: "An entry: open, apply, save as a file, delete", mouse: true },
          { keys: "right-click", does: "A workflow: try, edit, export, open in ComfyUI", mouse: true },
        ],
      },
    ],
  },
];

export const placeById = (id: PlaceId): KeyPlace => PLACES.find((p) => p.id === id)!;
export const rowCount = (p: KeyPlace): number => p.groups.reduce((n, g) => n + g.rows.length, 0);

/**
 * The keys of a named row, for what shows them elsewhere (the command bar's rows). `half` takes one of a pair: the
 * first or the second chord of "Alt+[ Alt+]" (previous / next take). Undefined when the row is gone.
 */
export function rowKeys(id: RowId, half?: 0 | 1): string | undefined {
  for (const p of PLACES) for (const g of p.groups) for (const r of g.rows) {
    if (r.id !== id) continue;
    if (half === undefined) return r.keys;
    // a pair is written as its chords side by side, one alternative: "Alt+[ Alt+]"
    const chords = r.keys.split("|")[0]!.trim().split(/\s+/);
    return chords[half];
  }
  return undefined;
}
