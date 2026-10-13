import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { modelName } from "@afflatus/core";
import { api, type RecipeInfo } from "./api";
import { useFamilies, useQueue, useRecipes, useSetup } from "./data";
import { useLoadChoices, type LoadChoice } from "./loadChoices";
import { machineLabel, severalMachines } from "./machines";
import { useStripForm } from "./ModelLoad";
import { Popover } from "./Popover";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";
import { cx } from "./ui";

/** Asked by the menus ("Load a model…"): the panel opens, on the machine named when there is one. */
const OPEN_LOAD = "afflatus:load-model";
export const openLoadPanel = (machine?: string) => window.dispatchEvent(new CustomEvent(OPEN_LOAD, { detail: { machine } }));

/** Past this many rows of all the models, typing more narrows them: a long list is not read. */
const MANY = 30;

/**
 * A family's plain operation: its first with a model input and nothing it must be given (a picture, a clip, a sound),
 * txt2img or text-to-video. A bare model file is loaded with it.
 */
function plainOf(recipes: RecipeInfo[], family: string): { recipe: RecipeInfo; input: string } | null {
  for (const r of recipes) {
    if (r.family !== family) continue;
    const model = r.inputs.find((i) => i.type === "model");
    const needs = r.inputs.some((i) => (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional);
    if (model && !needs) return { recipe: r, input: model.id };
  }
  return null;
}

type Row =
  | { kind: "choice"; key: string; family: string; file: string; from: string; ofForm: boolean; choice: LoadChoice }
  | { kind: "file"; key: string; family: string; file: string; from: string; recipe: string; input: string; path: string };

/**
 * "Load a model…" (the model strip's menu, a machine's menu): a panel by the status bar, in place of a submenu of a
 * submenu. Where, once at the top (Auto: the machine that would render it first; or one machine, the one whose menu
 * opened it); one row per model on two lines, its family as a tag, the file whole, where it comes from (this form, a
 * draft); typing finds any model file the machine has, loaded with its family's plain operation. ↑↓ and Enter.
 */
export function LoadPanelHost({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState<{ machine?: string } | null>(null);
  useEffect(() => {
    const show = (e: Event) => setOpen({ machine: (e as CustomEvent<{ machine?: string }>).detail?.machine });
    window.addEventListener(OPEN_LOAD, show);
    return () => window.removeEventListener(OPEN_LOAD, show);
  }, []);
  if (!open) return null;
  return <LoadPanel anchor={anchor} machine={open.machine} onClose={() => setOpen(null)} />;
}

function LoadPanel({ anchor, machine: asked, onClose }: { anchor: RefObject<HTMLElement | null>; machine?: string; onClose(): void }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const [machine, setMachine] = useState<string | undefined>(several.length ? asked : undefined);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const form = useStripForm();
  const { choices, load, lacksOn } = useLoadChoices(form);
  const recipes = useRecipes();
  const families = useFamilies(machine);
  const setup = useSetup(machine);
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const input = useRef<HTMLInputElement>(null);
  // after the menu that opened it has closed: a menu gives the focus back to where it was as it goes
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const words = query.trim().toLowerCase();
  const hits = (text: string) => !words || text.toLowerCase().includes(words);

  const rows = useMemo((): { listed: Row[]; all: Row[] } => {
    // the form's and the drafts' models, as the menus list them (loadChoices.ts)
    const listed: Row[] = choices
      .map((c): Row => ({ kind: "choice", key: c.key, family: c.family, file: c.file, from: c.note ?? "", ofForm: c.ofForm, choice: c }))
      .filter((r) => hits(`${r.family} ${r.file} ${r.from}`));
    if (!words) return { listed, all: [] };
    // every model file of the families that are on, on that machine (all of them with Auto), each once: a family's own
    // files are the ones its slot's patterns fit (a folder like diffusion_models holds every family's); an input with no
    // slot (an SDXL checkpoint) offers its folder, less the files another family's patterns claim
    const seen = new Set(listed.map((r) => r.file.toLowerCase()));
    const slotFiles = (family: string, slot: string) => setup.data?.families.find((x) => x.id === family)?.slots.find((x) => x.id === slot)?.choices ?? [];
    const claimedBy = (family: string) => new Set((setup.data?.families ?? []).filter((x) => x.id !== family).flatMap((x) => x.slots.flatMap((sl) => sl.choices)));
    const all: Row[] = [];
    for (const f of recipes.data?.families ?? []) {
      if (!families.isOn(f.id)) continue;
      const plain = plainOf(recipes.data?.recipes ?? [], f.id);
      if (!plain) continue;
      const folder = plain.recipe.inputs.find((i) => i.id === plain.input && i.type === "model");
      const slot = folder && "slot" in folder ? folder.slot : undefined;
      const files = slot ? slotFiles(f.id, slot) : (() => {
        const others = claimedBy(f.id);
        return (setup.data?.recipes.find((r) => r.id === plain.recipe.id)?.options[plain.input] ?? []).filter((x) => !others.has(x));
      })();
      for (const path of files) {
        const file = modelName(path);
        if (seen.has(file.toLowerCase()) || !hits(`${f.name} ${file}`)) continue;
        seen.add(file.toLowerCase());
        all.push({ kind: "file", key: `file:${path}`, family: f.name, file, from: `${folder && "folder" in folder ? folder.folder : "models"} · loads with ${plain.recipe.title}`, recipe: plain.recipe.id, input: plain.input, path });
      }
    }
    return { listed, all: all.slice(0, MANY) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- what it is built from, not the helpers
  }, [choices, words, recipes.data, setup.data, families]);
  const flat = [...rows.listed, ...rows.all];
  const lacks = (r: Row) => Boolean(machine) && r.kind === "choice" && r.ofForm && lacksOn(machine!);
  const pickable = flat.filter((r) => !lacks(r));
  const current = pickable[Math.min(at, pickable.length - 1)];

  const go = async (r: Row) => {
    onClose();
    if (r.kind === "choice") return load(r.choice, machine);
    const where = machine ? several.find((m) => m.id === machine) : undefined;
    try {
      await api.warm(r.recipe, { [r.input]: r.path }, null, machine);
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading ${r.file}${where ? ` on ${machineLabel(where)}` : ""}`, text: "Queued: the next render with it starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load ${r.file}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };

  const rowOf = (r: Row) => {
    const off = lacks(r);
    const on = current?.key === r.key;
    return (
      <div key={r.key} className={cx("grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line px-3.5 py-2", on && "bg-hover", r.kind === "choice" && r.ofForm && "bg-accent-wash/40")} onMouseEnter={() => !off && setAt(pickable.indexOf(r))}>
        <span className="justify-self-start truncate rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-ink-2" data-tip={r.family}>{r.family}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs text-ink" data-tip={r.file}>{r.file}</span>
          <span className={cx("truncate text-[11.5px]", r.kind === "choice" && r.ofForm ? "text-accent" : "text-ink-3")}>{r.from}</span>
        </span>
        <button
          type="button"
          disabled={off}
          onClick={() => void go(r)}
          data-tip={off ? "That machine has not this form's files: Settings › Models, its tab, says what it lacks" : undefined}
          className={cx("rounded-md border px-2.5 py-1 text-xs font-semibold whitespace-nowrap", off ? "border-line text-ink-3" : on ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-hover")}
        >
          {off ? "lacks it" : "Load"}
        </button>
      </div>
    );
  };

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((n) => Math.min(n + 1, pickable.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setAt((n) => Math.max(n - 1, 0)); }
    if (e.key === "Enter" && current) { e.preventDefault(); void go(current); }
  };
  const where = machine ? machineLabel(several.find((m) => m.id === machine) ?? { name: machine, url: "" }) : several.length ? "every machine" : "ComfyUI";

  return (
    <Popover anchor={anchor} onClose={onClose} label="Load a model" width={480} height={460}>
      <div className="flex flex-col text-[13px]" onKeyDown={key}>
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5">
          <span className="font-bold">Load a model</span>
          <span className="text-xs text-ink-3">ahead, while you write</span>
        </div>
        {several.length > 0 && (
          <div className="flex items-center gap-2.5 px-3.5 pb-2.5">
            <span className="text-xs text-ink-3">on</span>
            <div className="flex gap-0.5 rounded-[9px] border border-line bg-raised p-[3px] text-xs" role="radiogroup" aria-label="On which machine">
              {[{ id: undefined as string | undefined, label: "Auto", away: false, tip: "The machine that would render it first: it has its files, is free soonest, is fastest" }, ...several.map((m) => ({ id: m.id as string | undefined, label: machineLabel(m), away: m.online === false, tip: m.online === false ? "Not answering" : undefined }))].map((o) => (
                <button
                  key={o.id ?? "auto"}
                  type="button"
                  role="radio"
                  aria-checked={machine === o.id}
                  disabled={o.away}
                  data-tip={o.tip}
                  onClick={() => { setMachine(o.id); setAt(0); }}
                  className={cx("flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 whitespace-nowrap", machine === o.id ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:text-ink", o.away && "opacity-60")}
                >
                  {o.id && <span className={cx("size-[7px] rounded-full", o.away ? "bg-warn" : "border-[1.5px] border-good")} />}
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="px-3.5 pb-3">
          <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5 focus-within:border-accent">
            <Search size={13} className="shrink-0 text-ink-3" />
            <input ref={input} value={query} onChange={(e) => { setQuery(e.target.value); setAt(0); }} placeholder={`Find any model on ${where}…`} aria-label="Find a model" className="min-w-0 grow bg-transparent text-[13px] outline-none placeholder:text-ink-3" />
          </label>
        </div>
        <div className="max-h-[52vh] overflow-y-auto">
          {rows.listed.filter((r) => r.kind === "choice" && r.ofForm).map(rowOf)}
          {rows.listed.some((r) => !(r.kind === "choice" && r.ofForm)) && <div className="border-t border-line px-3.5 pt-2 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Recent drafts</div>}
          {rows.listed.filter((r) => !(r.kind === "choice" && r.ofForm)).map(rowOf)}
          {rows.all.length > 0 && <div className="border-t border-line px-3.5 pt-2 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">All models{rows.all.length >= MANY ? ` · the first ${MANY}` : ""}</div>}
          {rows.all.map(rowOf)}
          {!flat.length && <div className="border-t border-line px-3.5 py-3 text-xs text-ink-3">{words ? `No model called "${query.trim()}" on ${where}.` : "No form open and no draft yet: type a model's name."}</div>}
        </div>
      </div>
    </Popover>
  );
}
