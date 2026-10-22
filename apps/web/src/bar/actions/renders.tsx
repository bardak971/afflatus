import { Eye, FolderOpen, Plus } from "lucide-react";
import type { Asset, CommandEntry } from "../../api";
import type { MenuItem } from "../../ContextMenu";
import { formPlaces } from "../../formTarget";
import { placeMenu } from "../../itemActions";
import { copyText } from "../../secureContext";
import { askViewer } from "../../viewer/ask";
import type { Action, BarCtx } from "./ctx";

/** A submenu of the app's own menus, laid flat: "Timeline › Add to Harbor walk". */
function flatten(items: MenuItem[], path = ""): Action[] {
  const out: Action[] = [];
  for (const it of items) {
    if (it === "—") continue;
    const label = path ? `${path} › ${it.label}` : it.label;
    if (it.items) out.push(...flatten(it.items, label));
    else if (it.run) out.push({ label, note: it.note, icon: it.icon, danger: it.danger, disabled: it.disabled, keys: it.key, run: it.run });
  }
  return out;
}

/**
 * The selected render's actions: the item's list (itemActions.tsx), as every place shows it, with the viewer's keys
 * named. Open first (Enter opens it, as Open's key says), then the bar's own section (Show in its folder, on Ctrl +
 * Enter as before; Use in this draft), then the rest of the list. Trim and Details open the viewer with them.
 */
function subjectActions(x: BarCtx, a: Asset, project: string | null): Action[] {
  const { item, setViewing } = x;
  const openWith = (what: "trim" | "details") => () => {
    askViewer(a.id, what);
    setViewing(a);
  };
  const list = item.list({}, {
    open: () => setViewing(a),
    trim: openWith("trim"),
    details: openWith("details"),
    "copy-seed": () => item.seed !== null && copyText(String(item.seed)).then(() => x.onCopied(`the seed ${item.seed}`), () => x.onCopied("")),
    "copy-prompt": () => item.prompt && copyText(item.prompt).then(() => x.onCopied("the prompt"), () => x.onCopied("")),
  }, { "save-frame": "the first frame" });
  const places = formPlaces(x.formTarget, a);
  const own: MenuItem[] = [
    { label: a.inBin ? "Show in the bin" : "Show in its folder", icon: <FolderOpen size={14} />, note: "in the Studio", run: () => void x.showInFolder(a.id, project).catch(x.failed("Could not show it")) },
    ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: x.formTarget?.recipe.title, items: places }] : []),
  ];
  // Open first by name, not by place (the bin's own list leads with Put back); an item in the bin then has Put back on
  // Ctrl + Enter, any other its folder
  const rest = placeMenu([], list, "command");
  const take = (label: string): MenuItem[] => {
    const i = rest.findIndex((m) => m !== "—" && m.label === label);
    return i < 0 ? [] : rest.splice(i, 1);
  };
  const open = take("Open");
  const back = a.inBin ? take("Put back") : [];
  const out = flatten([...open, ...back, ...own, ...rest]);
  // the seed or the prompt copied, the bar stays (as a figure of the calculator)
  return out.map((y) => (y.label === "Copy the seed" || y.label === "Copy the prompt" ? { ...y, stay: true } : y));
}

/** A render of the library: its full list once it is read (its generation), until then what needs nothing more. */
export function renderActions(x: BarCtx, a: Extract<CommandEntry, { kind: "asset" }>): Action[] {
  if (x.subject && x.subject.id === a.id) return subjectActions(x, x.subject, a.project);
  return [
    { label: "Open", icon: <Eye size={14} />, keys: "Enter", run: () => x.view(a.id).catch(x.failed("Could not open it")) },
    { label: a.inBin ? "Show in the bin" : "Show in its folder", icon: <FolderOpen size={14} />, note: "in the Studio", run: () => x.showInFolder(a.id, a.project).catch(x.failed("Could not show it")) },
    { label: "Reading what was made with it…", disabled: true, note: "a moment", run: () => {} },
  ];
}
