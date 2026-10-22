import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { modelName } from "@afflatus/core";
import { api, type RecipeInfo } from "./api";
import { useFamilies, useQueue, useRecipes, useSetup } from "./data";
import { fileLabel } from "./format";
import { listedOn, useLoadChoices, type LoadChoice } from "./loadChoices";
import { machineLabel, severalMachines } from "./machines";
import { useStripForm } from "./ModelLoad";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";
import { cx, SearchField } from "./ui";

/** Past this many rows of all the models, typing more narrows them: a long list is not read. */
const MANY = 40;

/**
 * A family's plain operation: its first with a model input and nothing it must be given (a picture, a clip, a sound),
 * txt2img or text-to-video. A bare model file is loaded with it.
 */
function plainOf(recipes: RecipeInfo[], family: string): RecipeInfo | null {
  for (const r of recipes) {
    if (r.family !== family) continue;
    const model = r.inputs.some((i) => i.type === "model");
    const needs = r.inputs.some((i) => (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional);
    if (model && !needs) return r;
  }
  return null;
}

type Row =
  | { kind: "choice"; key: string; family: string; file: string; from: string; ofForm: boolean; recipe: string; input: string | null; path: string | null; choice: LoadChoice }
  | { kind: "file"; key: string; family: string; file: string; from: string; ofForm: false; recipe: string; input: string; path: string };

/**
 * "Load a model…": a dialog in the middle of the screen, in the command bar's frame. Where, once at the top (Auto: the
 * machine that would render it first; or one machine, the one whose menu opened it); one row per model on two lines,
 * its family as a tag, the file as it is written, where it comes from (this form, a draft), a dot per machine that has
 * it and where it is loaded already; typing finds any model file the machine has, loaded with its family's plain
 * operation. ↑↓, Enter, Esc.
 */
export function LoadDialog({ machine: asked, onClose }: { machine?: string; onClose(): void }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const [machine, setMachine] = useState<string | undefined>(several.length ? asked : undefined);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const form = useStripForm();
  const { choices, load, lacksOn, setups } = useLoadChoices(form);
  const recipes = useRecipes();
  const families = useFamilies(machine);
  const setup = useSetup(machine);
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // after the menu that opened it has closed: a menu gives the focus back to where it was as it goes
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const words = query.trim().toLowerCase();
  const hits = (text: string) => !words || text.toLowerCase().includes(words);

  const rows = useMemo((): { listed: Row[]; all: Row[] } => {
    // the form's and the drafts' models (loadChoices.ts)
    const listed: Row[] = choices
      .map((c): Row => ({ kind: "choice", key: c.key, family: c.family, file: c.file, from: c.note ?? "", ofForm: c.ofForm, recipe: c.recipe, input: c.input, path: c.path, choice: c }))
      .filter((r) => hits(`${r.family} ${r.file} ${r.from}`));
    if (!words) return { listed, all: [] };
    // every model file of the families that are on, on that machine (all of them with Auto), each once: a family's own
    // files are the ones its slot's patterns fit (a folder like diffusion_models holds every family's); an input with no
    // slot (an SDXL checkpoint) offers its folder, less the files another family's patterns claim
    const seen = new Set(listed.map((r) => modelName(r.path ?? r.file)));
    const slotFiles = (family: string, slot: string) => setup.data?.families.find((x) => x.id === family)?.slots.find((x) => x.id === slot)?.choices ?? [];
    const claimedBy = (family: string) => new Set((setup.data?.families ?? []).filter((x) => x.id !== family).flatMap((x) => x.slots.flatMap((sl) => sl.choices)));
    const all: Row[] = [];
    for (const f of recipes.data?.families ?? []) {
      if (!families.isOn(f.id)) continue;
      const plain = plainOf(recipes.data?.recipes ?? [], f.id);
      if (!plain) continue;
      // each of its model inputs (Wan has two: high and low noise) with the files that fit it; a file that fits several
      // goes with the input whose slot picks it on its own (both of Wan's slots list both files, each its own first)
      const specs = plain.inputs.flatMap((spec) => {
        if (spec.type !== "model") return [];
        const slot = "slot" in spec && spec.slot ? setup.data?.families.find((x) => x.id === f.id)?.slots.find((x) => x.id === spec.slot) : undefined;
        const files = "slot" in spec && spec.slot
          ? slotFiles(f.id, spec.slot)
          : (() => {
              const others = claimedBy(f.id);
              return (setup.data?.recipes.find((r) => r.id === plain.id)?.options[spec.id] ?? []).filter((x) => !others.has(x));
            })();
        return [{ spec, files, own: slot?.auto ?? slot?.file ?? null }];
      });
      const twoInputs = specs.length > 1;
      for (const { spec, files } of specs) {
        for (const path of files) {
          const home = specs.find((x) => x.own === path) ?? specs.find((x) => x.files.includes(path));
          if (home?.spec.id !== spec.id) continue;
          const file = fileLabel(path);
          if (seen.has(modelName(path)) || !hits(`${f.name} ${file}`)) continue;
          seen.add(modelName(path));
          all.push({ kind: "file", key: `file:${path}`, family: f.name, file, from: `${"folder" in spec ? spec.folder : "models"} · loads with ${plain.title}${twoInputs ? ` (${spec.label})` : ""}`, ofForm: false, recipe: plain.id, input: spec.id, path });
        }
      }
    }
    return { listed, all: all.slice(0, MANY) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- what it is built from, not the helpers
  }, [choices, words, recipes.data, setup.data, families]);
  const flat = [...rows.listed, ...rows.all];

  /** Each machine's word on a row: it has the file (true), has not (false), or it cannot be told (null). */
  const has = (r: Row) => several.map((m, i) => ({ m, listed: r.kind === "choice" && r.ofForm ? (setups[i] ? !lacksOn(m.id) : null) : listedOn(setups[i], r.recipe, r.input, r.path) }));
  const loadedOn = (r: Row) => (r.path ? several.filter((m) => m.model && m.model.toLowerCase() === modelName(r.path!)) : []);
  const lacks = (r: Row) => Boolean(machine) && has(r).find((h) => h.m.id === machine)?.listed === false;
  const pickable = flat.filter((r) => !lacks(r));
  const current = pickable[Math.min(at, pickable.length - 1)];
  useEffect(() => {
    list.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [current?.key]);

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
    const loaded = loadedOn(r);
    return (
      <div
        key={r.key}
        data-current={on ? "" : undefined}
        className={cx("grid grid-cols-[96px_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-line px-5 py-2.5", on && "bg-hover", r.ofForm && !on && "bg-accent-wash/30")}
        onMouseEnter={() => !off && setAt(pickable.indexOf(r))}
      >
        <span className="justify-self-start truncate rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-ink-2" data-tip={r.family}>{r.family}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[12.5px] text-ink" data-tip={r.path ?? r.file}>{r.file}</span>
          <span className={cx("truncate text-xs", r.ofForm ? "text-accent" : "text-ink-3")}>{r.from}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {loaded.length > 0 && <span className="rounded-full bg-good/15 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-good" data-tip="Held there now: a render with it there starts sampling at once">loaded on {loaded.map(machineLabel).join(", ")}</span>}
          {several.length > 0 && (
            <span className="flex gap-1">
              {has(r).map(({ m, listed }) => (
                <span
                  key={m.id}
                  data-tip={`${machineLabel(m)}: ${listed === null ? "not known" : listed ? "has it" : "lacks it"}`}
                  className={cx("size-[7px] rounded-full", listed === true ? "bg-good" : listed === false ? "border-[1.5px] border-ink-3" : "bg-line-strong")}
                />
              ))}
            </span>
          )}
        </span>
        <button
          type="button"
          disabled={off}
          onClick={() => void go(r)}
          data-tip={off ? "That machine has not this model: Settings › Models, its tab, says what it lacks" : undefined}
          className={cx("rounded-md border px-3 py-1 text-xs font-semibold whitespace-nowrap", off ? "border-line text-ink-3" : on ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-raised")}
        >
          {off ? "lacks it" : "Load"}
        </button>
      </div>
    );
  };

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((n) => Math.min(n + 1, pickable.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setAt((n) => Math.max(n - 1, 0)); }
    if (e.key === "Enter" && current) { e.preventDefault(); void go(current); }
  };
  const where = machine ? machineLabel(several.find((m) => m.id === machine) ?? { name: machine, url: "" }) : several.length ? "every machine" : "ComfyUI";
  const options = [
    { id: undefined as string | undefined, label: "Auto", away: false, tip: "The machine that would render it first: it has its files, is free soonest, is fastest" },
    ...several.map((m) => ({ id: m.id as string | undefined, label: machineLabel(m), away: m.online === false, tip: m.online === false ? "Not answering" : undefined })),
  ];

  return createPortal(
    <div className="fixed inset-0 z-[85]" onKeyDown={key}>
      {/* the page behind, dimmed as the command bar dims it: a click on it closes the dialog */}
      <div aria-hidden className="absolute inset-0 bg-ground/55 backdrop-blur-[3px] animate-bar-fade motion-reduce:animate-none" onPointerDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Load a model"
        className={cx(
          "absolute top-[11vh] left-1/2 flex max-h-[78vh] w-[760px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line-strong bg-panel/95 backdrop-blur-md",
          "shadow-[0_40px_120px_-12px_color-mix(in_srgb,var(--color-shade)_75%,transparent),0_0_0_1px_color-mix(in_srgb,var(--color-accent)_12%,transparent),0_0_70px_-8px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]",
          "origin-top animate-bar-in motion-reduce:animate-none",
        )}
      >
        <SearchField
          look="head"
          inputRef={input}
          value={query}
          onChange={(text) => { setQuery(text); setAt(0); }}
          placeholder={`Load a model: find any on ${where}…`}
          label="Find a model"
          icon={<Search size={17} className="shrink-0 text-accent" />}
          className="gap-3 px-5 py-4"
          inputClassName="text-[17px]"
          end={<span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">Esc</span>}
        />
        {several.length > 0 && (
          <div className="flex items-center gap-3 border-b border-line px-5 py-2.5">
            <span className="text-xs text-ink-3">on</span>
            <div className="flex gap-0.5 rounded-[9px] border border-line bg-raised p-[3px] text-xs" role="radiogroup" aria-label="On which machine">
              {options.map((o) => (
                <button
                  key={o.id ?? "auto"}
                  type="button"
                  role="radio"
                  aria-checked={machine === o.id}
                  disabled={o.away}
                  data-tip={o.tip}
                  onClick={() => { setMachine(o.id); setAt(0); input.current?.focus(); }}
                  className={cx("flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 whitespace-nowrap", machine === o.id ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:text-ink", o.away && "opacity-60")}
                >
                  {o.id && <span className={cx("size-[7px] rounded-full", o.away ? "bg-warn" : "border-[1.5px] border-good")} />}
                  {o.label}
                </button>
              ))}
            </div>
            <span className="grow" />
            <span className="text-xs text-ink-3">ahead, while you write: one step, nothing saved</span>
          </div>
        )}
        <div ref={list} className="min-h-0 overflow-y-auto">
          {rows.listed.filter((r) => r.ofForm).map(rowOf)}
          {rows.listed.some((r) => !r.ofForm) && <div className="border-t border-line px-5 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Recent drafts</div>}
          {rows.listed.filter((r) => !r.ofForm).map(rowOf)}
          {rows.all.length > 0 && <div className="border-t border-line px-5 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">All models{rows.all.length >= MANY ? ` · the first ${MANY}` : ""}</div>}
          {rows.all.map(rowOf)}
          {!flat.length && <div className="border-t border-line px-5 py-4 text-sm text-ink-3">{words ? `No model called "${query.trim()}" on ${where}.` : "No form open and no draft yet: type a model's name."}</div>}
        </div>
        <div className="flex items-center gap-4 border-t border-line px-5 py-2 text-[11.5px] text-ink-3">
          <span>↑↓ move</span><span>Enter load</span><span>Esc close</span>
          {several.length > 0 && <span className="ml-auto">a dot per machine: filled, it has the model</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
