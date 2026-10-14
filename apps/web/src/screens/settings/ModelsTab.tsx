import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronDown, X } from "lucide-react";
import { folderOfFileInput } from "@afflatus/core";
import { api, type Machine, type RecipeInfo } from "../../api";
import { useFamilies, useRecipes, useSettings, useSetup } from "../../data";
import { fileLabel, plural, problemSaid } from "../../format";
import { GetFile } from "../../GetFile";
import { machineLabel } from "../../machines";
import { DownloadTo } from "../../useGetFile";
import { Select } from "../../Select";
import { Chip, cx, ErrorNote, Help, Toggle } from "../../ui";
import { Block, Card } from "./Rows";
import { modelHelp } from "../../modelHelp";
import { queryKeys } from "../../queryKeys";

/**
 * The family's files where more than one fits (two SeedVR2 models, two turbo LoRAs): which one is used,
 * chosen by hand or left to the patterns. Nothing shown for a family whose files are all one of a kind.
 */
function SlotChoices({ family, machine }: { family: string; machine?: string }) {
  const setup = useSetup(machine);
  const settings = useSettings();
  const client = useQueryClient();
  const slots = (setup.data?.families.find((f) => f.id === family)?.slots ?? []).filter((s) => s.choices.length > 1 || s.chosen);
  const save = useMutation({
    mutationFn: (v: { slot: string; file: string }) => {
      const all = { ...(settings.data?.slotFiles ?? {}) };
      const mine = { ...(all[family] ?? {}) };
      if (v.file) mine[v.slot] = v.file;
      else delete mine[v.slot];
      if (Object.keys(mine).length) all[family] = mine;
      else delete all[family];
      return api.saveSettings({ slotFiles: all });
    },
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: queryKeys.settings() }), client.invalidateQueries({ queryKey: queryKeys.setup() })]),
  });
  if (!slots.length) return null;
  return (
    <div data-setting="models.files" className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Files in use <Help title="Files in use" text="More than one file fits here. Left to itself, Afflatus takes the first its patterns name; pick another to use it everywhere this family does." /></span>
      {slots.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col"><span className="truncate text-xs font-semibold">{s.label}</span><span className="truncate text-xs text-ink-3">{s.folder}</span></span>
          <div className="w-80 shrink-0">
            <Select
              size="sm"
              label={`File used for ${s.label}`}
              value={s.chosen ? (s.file ?? "") : ""}
              onChange={(file) => save.mutate({ slot: s.id, file })}
              options={[{ value: "", label: s.auto ? `Automatic: ${fileLabel(s.auto)}` : "Automatic", note: "the first its patterns name" }, ...s.choices.map((f) => ({ value: f, label: fileLabel(f) }))]}
            />
          </div>
        </div>
      ))}
      {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
    </div>
  );
}

/** One recipe: ready, or what it lacks and how to get it. */
function ReadyRow({ r, machine }: { r: RecipeInfo; machine?: string }) {
  const setup = useSetup(machine);
  const recipes = useRecipes();
  const s = setup.data?.recipes.find((x) => x.id === r.id);
  const family = recipes.data?.families.find((f) => f.id === r.family);
  const problems = [
    ...(s?.missingNodes.length ? [`Missing custom nodes: ${s.missingNodes.join(", ")}`] : []),
    ...(s?.problems ?? []).map((p) => `${problemSaid(p)}${r.imported ? " Fix it in Workflows, with Edit." : ""}`),
    ...(s?.emptyInputs ?? []).map((id) => {
      const input = r.inputs.find((i) => i.id === id);
      return `ComfyUI has no model file for "${input?.label ?? id}"${input?.note ? ` (${input.note})` : ""}`;
    }),
  ];
  const find = (file: string) => encodeURIComponent(fileLabel(file));
  // the family's own files: the ones it cannot run without, and the ones only some of its options need
  const slots = setup.data?.families.find((f) => f.id === r.family)?.slots ?? [];
  const needed = slots.filter((x) => s?.missingSlots.includes(x.id));
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-baseline gap-2.5">
        <span className={cx("h-2 w-2 shrink-0 translate-y-[-1px] rounded-full", s?.ready ? "bg-good" : s ? "bg-warn-ink" : "bg-ink-3")} />
        <span className="w-36 shrink-0 truncate font-semibold">{r.title}</span>
        <span className="min-w-0 grow truncate text-xs text-ink-2" data-tip={r.summary}>{r.summary}</span>
        <span className={cx("shrink-0 text-xs font-semibold", s?.ready ? "text-good" : "text-warn-ink")}>{s ? (s.ready ? "Ready" : "Not ready") : "Unknown"}</span>
      </div>
      {problems.map((p) => <div key={p} className="text-warn-ink">{p}</div>)}
      {needed.map((x) => (
        <div key={x.id} className="text-warn-ink">
          <span className="font-semibold">{x.label}</span> is missing. {x.hint}
          {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={family?.name ? [family.name] : []} />}
        </div>
      ))}
      {(s?.missing ?? []).map(({ file, folder, url }) => (
        <div key={file} className="text-warn-ink">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>Missing: <span className="font-semibold break-all">{fileLabel(file)}</span></span>
            <Help text={`Your ComfyUI does not have this file. Search for it on Civitai or Hugging Face, or download it here${r.imported ? "; or pick another file for it in Workflows, with Edit" : ""}.`} />
            <span className="text-ink-3">·</span>
            <a className="font-semibold underline" href={`https://civitai.com/search/models?query=${find(file)}`} target="_blank" rel="noreferrer">Civitai</a>
            <a className="font-semibold underline" href={`https://huggingface.co/models?search=${find(file)}`} target="_blank" rel="noreferrer">Hugging Face</a>
            {r.imported && <Link href="/workflows" className="font-semibold underline">Workflows</Link>}
          </span>
          <GetFile file={file} folder={folder} url={url} hints={family?.name ? [family.name] : []} />
        </div>
      ))}
      {s?.limitedBy.length ? <div className="text-ink-2">Some options are off, missing custom nodes: {s.limitedBy.join(", ")}</div> : null}
    </div>
  );
}

/**
 * The files a family's operations run without, that some option of theirs would use: once each, for the whole family (a
 * turbo LoRA three operations share was said three times), as a card with what it brings and its download. With them, the
 * image tools' detectors for an operation that picks one (a face detailer's detection model). Detectors only: a model
 * folder (diffusion_models) would bring in every other family's optional models.
 */
function OptionalFiles({ family, recipes, machine }: { family: string; recipes: RecipeInfo[]; machine?: string }) {
  const setup = useSetup(machine);
  const names = useRecipes().data?.families.find((f) => f.id === family)?.name;
  const slots = setup.data?.families.find((f) => f.id === family)?.slots ?? [];
  const folders = new Set<string>(recipes.flatMap((r) => r.inputs.flatMap((i) => (i.type === "choice" && i.options && !Array.isArray(i.options) ? [folderOfFileInput(i.options.node, i.options.input)] : []))).filter((f) => f === "ultralytics"));
  const owned = new Set(slots.map((x) => x.id));
  const lent = (setup.data?.families ?? []).filter((f) => f.id !== family).flatMap((f) => f.slots).filter((x) => folders.has(x.folder) && x.optional && !x.file && x.get && !owned.has(x.id));
  const offered = [...slots.filter((x) => x.optional && !x.file && x.get), ...lent.filter((x, i) => lent.findIndex((y) => y.id === x.id) === i)];
  if (!offered.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">
        Optional · {plural(offered.length, "file")}
        <Help text="Everything runs without these: each brings an option or a speed-up, said on its card." />
      </span>
      {offered.map((x) => (
        <div key={x.id} className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5">
          <span className="font-semibold">{x.label}</span>
          {/* the hint was written for a line that said "optional" in front of it: the card's section says so */}
          <span className="text-xs text-ink-2">{x.hint.replace(/^optional[:,]\s*/i, "").replace(/^./, (c) => c.toUpperCase())}</span>
          {x.get && <GetFile buttons file={x.get.file} folder={x.folder} url={x.get.url} hints={names ? [names] : []} />}
        </div>
      ))}
    </div>
  );
}


/**
 * The card's head: what it counts, said. A bare "15 of 15 ready" read as "everything is fine" under families that were
 * off with files missing; the count is of the operations of the families on.
 */
function readySaid(families: number, ready: number, operations: number): string {
  const on = `${families} on`;
  return ready === operations ? `${on} · all ready` : `${on} · ${ready} of ${operations} operations ready`;
}

/** What a family that is off says of its files: a fact, not a warning (a family left off is not a problem). */
const offSaid = (found: boolean) => (found ? "has its files" : "files missing");

/**
 * The model families, one row each: the switch (whether it is offered in the lists to choose from: the model list in
 * Studio, a clip's model on a timeline, the tools under a picture), whether its operations are ready, and opened, its
 * operations and files. The families that are on come first and only they warn of what is missing; those that are off
 * are folded below in grey, what they lack said as a fact, since leaving a family off is a choice. Left alone a family
 * follows its files; set by hand it stays as set. Nothing made with a family that is off is touched.
 *
 * `machine`: the same for one of several ComfyUIs (Settings › Models, its tab): what is ready there, its switch is whether
 * the queue sends that machine the family's jobs (over the switch of every machine), and Download goes to it.
 */
export function ModelsCard({ machine }: { machine?: Machine }) {
  const recipes = useRecipes();
  const settings = useSettings();
  const setup = useSetup(machine?.id);
  const families = useFamilies(machine?.id);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [offOpen, setOffOpen] = useState(false);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      machine
        ? api.saveSettings({ machines: (settings.data?.machines ?? []).map((m) => (m.id === machine.id ? { ...m, families: next } : m)) })
        : api.saveSettings({ families: next }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  if (!recipes.data || !settings.data) return null;
  // the switches set by hand that this card shows: the machine's own, or those of every machine
  const said = machine ? families.own : settings.data.families;
  const where = machine ? machineLabel(machine) : null;
  const shown = recipes.data.families.filter((f) => recipes.data.recipes.some((r) => r.family === f.id));
  const names = new Set<string>();
  const twice = new Set(shown.map((f) => f.name).filter((n) => (names.has(n) ? true : (names.add(n), false))));
  const readyOf = (id: string) => setup.data?.recipes.find((x) => x.id === id)?.ready ?? false;
  const on = shown.filter((f) => families.isOn(f.id));
  const off = shown.filter((f) => !families.isOn(f.id));
  const listed = recipes.data.recipes.filter((r) => families.isOn(r.family));
  const ready = listed.filter((r) => readyOf(r.id)).length;

  const row = (f: (typeof shown)[number]) => {
    const mine = recipes.data.recipes.filter((r) => r.family === f.id);
    const isOn = families.isOn(f.id);
    const imported = Boolean(f.imported);
    const found = imported || families.found(f.id);
    const name = `${f.name}${imported && twice.has(f.name) ? " (your workflows)" : ""}`;
    const good = mine.filter((r) => readyOf(r.id)).length;
    const all = good === mine.length;
    // files the family does not need, but some option of it would use: said as what they are
    const extras = (setup.data?.families.find((x) => x.id === f.id)?.slots ?? []).filter((x) => x.optional && !x.file && x.get).length;
    // a family that is on with something missing starts open; the rest start folded
    const open = opened[f.id] ?? (isOn && setup.data ? !all : false);
    return (
      <div key={f.id} className="flex flex-col">
        <div className="flex min-h-[52px] items-center gap-3 pr-[18px] hover:bg-hover">
          <button type="button" aria-expanded={open} onClick={() => setOpened({ ...opened, [f.id]: !open })} className="flex min-h-[52px] min-w-0 grow items-center gap-3 pl-[18px] text-left">
            <ChevronDown size={14} className={cx("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} />
            <span className={cx("truncate font-semibold", !isOn && "text-ink-2")}>{name}</span>
            {modelHelp(f) && <Help inside title={name} text={modelHelp(f)!} />}
            <span className="shrink-0 text-xs text-ink-3">{plural(mine.length, imported ? "workflow" : "operation")}</span>
            <span className="grow" />
            {setup.data && (isOn ? (
              <span className="flex shrink-0 items-baseline gap-2 text-xs">
                {all && extras > 0 && <span className="text-ink-3">{plural(extras, "optional file")} to add</span>}
                <span className={cx("font-semibold", all ? "text-good" : "text-warn-ink")}>{all ? "ready" : `${good} of ${mine.length} ready`}</span>
              </span>
            ) : (
              <span className="shrink-0 text-xs text-ink-3" data-tip={found ? undefined : `Its model files are not in ${where ?? "ComfyUI"}. Open it for what it needs and where to get each file; it turns on by itself once they are there, unless switched off by hand.`}>
                {offSaid(found)}
              </span>
            ))}
          </button>
          {f.id in said && (
            <Chip
              tone="link"
              tip={machine ? "Set by hand on this machine. Click to let it follow the switch of every machine (All), then its files here." : "Set by hand. Click to let it follow its model files again: on when they are in ComfyUI, off when they are not."}
              onClick={() => save.mutate(Object.fromEntries(Object.entries(said).filter(([id]) => id !== f.id)))}
            >
              {isOn ? "on" : "off"} by hand <X size={12} aria-hidden />
            </Chip>
          )}
          <Toggle bare on={isOn} onChange={(next) => save.mutate({ ...said, [f.id]: next })} label={where ? `${name} on ${where}` : `${name} in the model lists`} />
        </div>
        {open && (
          <div className="flex flex-col gap-3.5 border-t border-line bg-raised px-[18px] pt-3 pb-3.5">
            {f.help && <span className="text-xs text-ink-2">{f.help.what}</span>}
            <div className="flex flex-col">
              <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{imported ? "Workflows" : "Operations"}</span>
              {mine.map((r) => <ReadyRow key={r.id} r={r} machine={machine?.id} />)}
            </div>
            <OptionalFiles family={f.id} recipes={mine} machine={machine?.id} />
            <SlotChoices family={f.id} machine={machine?.id} />
          </div>
        )}
      </div>
    );
  };

  return (
    <DownloadTo.Provider value={machine?.id}>
      <Card
        id={machine ? undefined : "models"}
        setting={machine ? undefined : "models.families"}
        title={
          <span className="flex items-center gap-1.5">
            {where ? `Models on ${where}` : "Models"}
            <Help title="Models" text={machine ? `One row per model family, as ${where} has it. The switch: off, the queue sends ${where} nothing of that family; set here it wins over the switch of every machine (All). Open a family for its operations, the files they need, and a download to ${where}.` : "One row per model family. The switch: off, it is left out of the model lists (Studio, a clip's model on a timeline, the tools under a picture); what you made with it stays. Left alone a family follows its model files; set by hand it stays as set. Open a family for its operations, the files they need and where to get them. Only the families that are on warn of what is missing."} />
          </span>
        }
        status={setup.isLoading ? <span className="text-xs text-ink-3">Asking ComfyUI…</span> : setup.data && listed.length ? <span className={cx("font-mono text-xs", ready === listed.length ? "text-good" : "text-warn-ink")}>{readySaid(on.length, ready, listed.length)}</span> : null}
      >
        {setup.isError && <Block><ErrorNote>{setup.error.message}</ErrorNote></Block>}
        {setup.data && !setup.data.comfy.online && where && <Block className="text-ink-2">{where} does not answer: what it has is not known now.</Block>}
        {setup.data && !on.length && (
          <Block className="flex-row items-center gap-1.5 text-ink-2">
            No model found in {where ?? "ComfyUI"}
            <Help text="Put the files in, or download them (open a family below): each family turns on by itself. Its switch forces it on or off." />
          </Block>
        )}
        {on.map(row)}
        {off.length > 0 && (
          <button type="button" aria-expanded={offOpen} onClick={() => setOffOpen(!offOpen)} className="flex min-h-[40px] items-center gap-3 bg-raised px-[18px] text-left text-xs text-ink-3 hover:bg-hover">
            <span className="font-bold tracking-[0.08em] uppercase">{where ? "Off here" : "Off"} · {off.length}</span>
            <span className="grow" />
            <span>{where ? `the queue sends ${where} none of these` : "not in the model lists"}</span>
            <ChevronDown size={14} className={cx("shrink-0 transition-transform", offOpen && "rotate-180")} />
          </button>
        )}
        {offOpen && off.map(row)}
        {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
      </Card>
    </DownloadTo.Provider>
  );
}
