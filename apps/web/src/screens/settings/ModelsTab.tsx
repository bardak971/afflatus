import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronDown, X } from "lucide-react";
import { api, type RecipeInfo } from "../../api";
import { useFamilies, useRecipes, useSettings, useSetup } from "../../data";
import { fileLabel, problemSaid } from "../../format";
import { GetFile } from "../../GetFile";
import { Select } from "../../Select";
import { Chip, cx, ErrorNote, Help, Toggle } from "../../ui";
import { Block, Card } from "./Rows";
import { queryKeys } from "../../queryKeys";

/**
 * One switch per model: whether it is offered in the lists to choose from (the model list in Studio, a
 * clip's model on a timeline, the tools under a picture). Left alone a model follows its files; set by
 * hand it stays as set. Nothing made with a model that is off is touched.
 */
export function ModelSwitches() {
  const recipes = useRecipes();
  const settings = useSettings();
  const setup = useSetup();
  const families = useFamilies();
  const [needs, setNeeds] = useState<string | null>(null);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) => api.saveSettings({ families: next }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  if (!recipes.data || !settings.data) return null;
  const said = settings.data.families;
  const shown = recipes.data.families.filter((f) => recipes.data.recipes.some((r) => r.family === f.id));
  const names = new Set<string>();
  const twice = new Set(shown.map((f) => f.name).filter((n) => (names.has(n) ? true : (names.add(n), false))));
  const offCount = shown.filter((f) => !families.isOn(f.id)).length;
  return (
    <Card
      id="model-switches"
      setting="models.families"
      title={<span className="flex items-center gap-1.5">Models <Help title="Models" text="One switch per model family: off, it is left out of the model lists (Studio, a clip's model on a timeline, the tools under a picture). What you generated with it stays. Left alone a family follows its model files; set by hand it stays as set." /></span>}
      status={<span className="font-mono text-xs text-ink-3">{shown.length - offCount} of {shown.length} on</span>}
    >
        {shown.map((f) => {
          const mine = recipes.data.recipes.filter((r) => r.family === f.id);
          const found = families.found(f.id);
          const on = families.isOn(f.id);
          const byHand = f.id in said;
          const imported = Boolean(f.imported);
          const name = `${f.name}${imported && twice.has(f.name) ? " (your workflows)" : ""}`;
          // its files are not there: what it needs is said here, once, with the way to get each file
          const slots = found || imported ? [] : (setup.data?.families.find((x) => x.id === f.id)?.slots ?? []).filter((x) => !x.optional && !x.file);
          const open = needs === f.id;
          return (
            <div key={f.id} className="flex flex-col">
              <div className="flex min-h-[52px] items-center gap-3 px-[18px]">
                <span className={cx("truncate font-semibold", !on && "text-ink-2")}>{name}</span>
                <span className="shrink-0 text-xs text-ink-3">{imported ? `${mine.length} workflow${mine.length > 1 ? "s" : ""}` : `${mine.length} operation${mine.length > 1 ? "s" : ""}`}</span>
                <span className="grow" />
                {!found && (slots.length ? (
                  <button type="button" aria-expanded={open} data-tip="The model files it needs, and where to get them" onClick={() => setNeeds(open ? null : f.id)} className="flex shrink-0 items-center gap-1 text-xs font-semibold text-warn-ink hover:underline">
                    {slots.length} model file{slots.length > 1 ? "s" : ""} missing <ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-warn-ink" data-tip="No model of this family was found in ComfyUI. Put one in its models folder (an SDXL checkpoint goes in models/checkpoints); it is listed as soon as ComfyUI sees it.">no model file yet</span>
                ))}
                {byHand && (
                  <Chip
                    tone="link"
                    tip="Set manually. Click to let it follow its model files again: on when they are in ComfyUI, off when they are not."
                    onClick={() => save.mutate(Object.fromEntries(Object.entries(said).filter(([id]) => id !== f.id)))}
                  >
                    manual <X size={12} aria-hidden />
                  </Chip>
                )}
                <Toggle bare on={on} onChange={(next) => save.mutate({ ...said, [f.id]: next })} label={`${name} in the model lists`} />
              </div>
              {open && slots.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-line bg-raised px-[18px] py-2.5 text-xs text-ink-2">
                  {slots.map((x) => (
                    <div key={x.id}>
                      <span className="font-semibold text-ink">{x.label}</span>: {x.hint}
                      {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={[f.name]} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
    </Card>
  );
}

/**
 * The family's files where more than one fits (two SeedVR2 models, two turbo LoRAs): which one is used,
 * chosen by hand or left to the patterns. Nothing shown for a family whose files are all one of a kind.
 */
function SlotChoices({ family }: { family: string }) {
  const setup = useSetup();
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
    <div data-setting="models.files" className="flex flex-col gap-2 px-[18px] py-2.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold">Files in use <Help title="Files in use" text="More than one file fits here. Left to itself, Afflatus takes the first its patterns name; pick another to use it everywhere this family does." /></span>
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
function ReadyRow({ r }: { r: RecipeInfo }) {
  const setup = useSetup();
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
  const extra = s?.ready ? slots.filter((x) => x.optional && !x.file && x.get) : [];
  return (
    <div className="flex flex-col gap-1 px-[18px] py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{r.title}</span>
        <span className={cx("shrink-0 text-xs font-semibold", s?.ready ? "text-good" : "text-warn-ink")}>{s ? (s.ready ? "Ready" : "Not ready") : "Unknown"}</span>
      </div>
      {problems.map((p) => <div key={p} className="text-warn-ink">{p}</div>)}
      {needed.map((x) => (
        <div key={x.id} className="text-warn-ink">
          <span className="font-semibold">{x.label}</span> is missing. {x.hint}
          {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={family?.name ? [family.name] : []} />}
        </div>
      ))}
      {extra.map((x) => (
        <div key={x.id} className="text-ink-2">
          <span className="mr-1.5 rounded bg-raised px-1.5 py-px text-[10px] font-bold tracking-wide text-ink-3 uppercase">optional</span>
          <span className="font-semibold">{x.label}</span> is not installed; the operation runs without it. {x.hint}
          {x.get && <GetFile file={x.get.file} folder={x.folder} url={x.get.url} hints={family?.name ? [family.name] : []} />}
        </div>
      ))}
      {(s?.missing ?? []).map(({ file, folder, url }) => (
        <div key={file} className="text-warn-ink">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>Missing: <span className="font-semibold break-all">{fileLabel(file)}</span></span>
            <span className="text-ink-3">·</span>
            <a className="font-semibold underline" href={`https://civitai.com/search/models?query=${find(file)}`} target="_blank" rel="noreferrer">Civitai</a>
            <a className="font-semibold underline" href={`https://huggingface.co/models?search=${find(file)}`} target="_blank" rel="noreferrer">Hugging Face</a>
            {r.imported && <Link href="/workflows" className="font-semibold underline">Workflows</Link>}
            <Help text={`Your ComfyUI does not have this file. Search for it on Civitai or Hugging Face, or download it here${r.imported ? "; or pick another file for it in Workflows, with Edit" : ""}.`} />
          </span>
          <GetFile file={file} folder={folder} url={url} hints={family?.name ? [family.name] : []} />
        </div>
      ))}
      {s?.limitedBy.length ? <div className="text-ink-2">Some options are off, missing custom nodes: {s.limitedBy.join(", ")}</div> : null}
      {s?.ready && (
        <div className="text-xs text-ink-2">
          {Object.entries(s.options).map(([k, v]) => `${r.inputs.find((i) => i.id === k)?.label ?? k}: ${v.length}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

/**
 * The head of "What is ready": what it counts, said. A bare "15 of 15 ready" under a list of families that
 * are off with files missing read as "everything is fine"; the count is of the operations of the families on.
 */
function readySaid(families: number, ready: number, operations: number): string {
  const on = `${families} famil${families === 1 ? "y" : "ies"} on`;
  return ready === operations ? `${on} · all ready` : `${on} · ${ready} of ${operations} operations ready`;
}

/**
 * What is ready, by model family: one line per family that says how many of its operations can run,
 * open when something is missing, folded when all is well. Only the families that are on are listed.
 */
export function ReadyList() {
  const setup = useSetup();
  const recipes = useRecipes();
  const families = useFamilies();
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const listed = (recipes.data?.recipes ?? []).filter((r) => families.isOn(r.family));
  const readyOf = (id: string) => setup.data?.recipes.find((x) => x.id === id)?.ready ?? false;
  const ready = listed.filter((r) => readyOf(r.id)).length;
  const groups = (recipes.data?.families ?? []).map((f) => ({ family: f, recipes: listed.filter((r) => r.family === f.id) })).filter((g) => g.recipes.length);
  return (
    <Card
      id="ready"
      setting="models.ready"
      title={<span className="flex items-center gap-1.5">What is ready <Help title="What is ready" text="Every operation of the families that are on, by family: open when something is missing (files, custom nodes), folded when all is well. Models that are off are not listed." /></span>}
      status={setup.isLoading ? <span className="text-xs text-ink-3">Asking ComfyUI…</span> : setup.data && listed.length ? <span className={cx("font-mono text-xs", ready === listed.length ? "text-good" : "text-warn-ink")}>{readySaid(groups.length, ready, listed.length)}</span> : null}
    >
      {setup.isError && <Block><ErrorNote>{setup.error.message}</ErrorNote></Block>}
      {setup.data && !listed.length && (
        <Block className="flex-row items-center gap-1.5 text-ink-2">
          No model found in ComfyUI
          <Help text="Put the files in, or download them: each family turns on by itself. A switch under Models forces one on or off." />
        </Block>
      )}
        {groups.map(({ family, recipes: mine }) => {
          const good = mine.filter((r) => readyOf(r.id)).length;
          const all = good === mine.length;
          // a family with something missing starts open; one that is all ready starts folded
          const open = opened[family.id] ?? (setup.data ? !all : false);
          return (
            <div key={family.id} className="flex flex-col">
              <button type="button" aria-expanded={open} onClick={() => setOpened({ ...opened, [family.id]: !open })} className="flex min-h-[52px] items-center gap-3 px-[18px] text-left hover:bg-hover">
                <span className="truncate font-semibold">{family.name}</span>
                <span className="grow" />
                {(() => {
                  // files the family does not need, but some option of it would use: said as what they are
                  const extras = (setup.data?.families.find((x) => x.id === family.id)?.slots ?? []).filter((x) => x.optional && !x.file && x.get).length;
                  return (
                    <span className="flex shrink-0 items-baseline gap-2 text-xs">
                      {setup.data && all && extras > 0 && <span className="text-ink-3">{extras} optional file{extras > 1 ? "s" : ""} to add</span>}
                      <span className={cx("font-semibold", !setup.data ? "text-ink-3" : all ? "text-good" : "text-warn-ink")}>{setup.data ? (all ? `${mine.length} ready` : `${good} of ${mine.length} ready`) : `${mine.length} operation${mine.length > 1 ? "s" : ""}`}</span>
                    </span>
                  );
                })()}
                <ChevronDown size={14} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
              </button>
              {open && (
                <div className="flex flex-col divide-y divide-line border-t border-line bg-raised">
                  <SlotChoices family={family.id} />
                  {mine.map((r) => <ReadyRow key={r.id} r={r} />)}
                </div>
              )}
            </div>
          );
        })}
    </Card>
  );
}
