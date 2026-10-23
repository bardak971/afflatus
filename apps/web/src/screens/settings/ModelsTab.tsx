import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api, type Machine } from "../../api";
import { useFamilies, useOfficialSizes, useRecipes, useSettings, useSetup } from "../../data";
import { plural, size, waitsForGpu } from "../../format";
import { lacksOnlyFiles, officialFiles } from "../../officialFiles";
import { machineLabel } from "../../machines";
import { DownloadTo } from "../../useGetFile";
import { Button, Chip, CloseButton, cx, ErrorNote, Help, Toggle } from "../../ui";
import { Block, Card } from "./Rows";
import { DownloadAll, FamilyBody } from "./ModelsFamily";
import { modelHelp } from "../../modelHelp";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";

/**
 * The card's head: what it counts, said. A bare "15 of 15 ready" read as "everything is fine" under families that were
 * off with files missing; the count is of the operations of the families on.
 */
function readySaid(families: number, ready: number, operations: number): string {
  const on = `${families} on`;
  return ready === operations ? `${on} · all ready` : `${on} · ${ready} of ${operations} operations ready`;
}

/** Where the existing install's hint was closed: never shown again in this browser. */
const HINT_CLOSED = "afflatus.allFamiliesHint";

/**
 * An existing install's one line (where you render, card #20): its families still follow their files, those without them
 * off. "Turn them all on" sets the new rule (allFamilies: the switch says "I want it", the files listed greyed and coming
 * when a job needs them), switches set off by hand turned on too. Closed, it is not shown again.
 */
function AllOnHint({ off }: { off: number }) {
  const client = useQueryClient();
  const [closed, setClosed] = useState(() => localStorage.getItem(HINT_CLOSED) === "1");
  const settings = useSettings();
  const sayFailed = useSayFailed({ id: "all-families", href: "/settings/models", go: "Open Settings › Models" });
  const turn = useMutation({
    mutationFn: () => api.saveSettings({ allFamilies: true, families: Object.fromEntries(Object.entries(settings.data?.families ?? {}).filter(([, on]) => on)) }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
    onError: sayFailed("The families were not turned on"),
  });
  if (closed) return null;
  const close = () => {
    localStorage.setItem(HINT_CLOSED, "1");
    setClosed(true);
  };
  return (
    <Block className="flex-row items-center gap-3 text-ink-2">
      <span className="grow">{plural(off, "family is", "families are")} off. On, a family's forms list its files greyed, and they come when a job needs them.</span>
      <Button size="sm" disabled={turn.isPending} onClick={() => turn.mutate()} className="shrink-0">Turn them all on</Button>
      <CloseButton size={28} label="Close this hint" onClose={close} />
    </Block>
  );
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
  const sizes = useOfficialSizes();
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
  const listed = recipes.data.recipes.filter((r) => families.offers(r));
  const ready = listed.filter((r) => readyOf(r.id)).length;
  // with rented GPUs only (no ComfyUI of the user's own answering): the files come with the pod, nothing to download here
  const pod = waitsForGpu(setup.data?.comfy);
  const sizeOf = (url: string | undefined) => (url ? sizes.data?.[url] ?? 0 : 0);
  /** A family's needed files not here that have an official download: said as files to come, not as a warning. */
  const toCome = (id: string) => (setup.data?.families.find((x) => x.id === id)?.slots ?? []).filter((x) => !x.optional && !x.file && x.get);
  /** What a family's official files weigh, as a pod fetches them. */
  const podBytes = (id: string) => (recipes.data.families.find((x) => x.id === id)?.slots ?? []).filter((x) => !x.optional && x.get).reduce((n, x) => n + sizeOf(x.get!.url), 0);

  const row = (f: (typeof shown)[number]) => {
    const mine = recipes.data.recipes.filter((r) => r.family === f.id && !r.hidden);
    const isOn = families.isOn(f.id);
    const imported = Boolean(f.imported);
    const found = imported || families.found(f.id);
    const name = `${f.name}${imported && twice.has(f.name) ? " (your workflows)" : ""}`;
    const good = mine.filter((r) => readyOf(r.id)).length;
    const all = good === mine.length;
    // files the family does not need, but some option of it would use: said as what they are
    const extras = (setup.data?.families.find((x) => x.id === f.id)?.slots ?? []).filter((x) => x.optional && !x.file && x.get).length;
    // what it lacks is only files with an official download: they come (Download all), the family is not broken
    const info = recipes.data.families.find((x) => x.id === f.id);
    const statusOf = (id: string) => setup.data?.recipes.find((x) => x.id === id);
    // its operations that lack only files with an official download (they come), and those that lack more (a node pack)
    const waiting = all ? [] : mine.filter((r) => !readyOf(r.id) && lacksOnlyFiles(statusOf(r.id), r, info));
    const stuck = all ? 0 : mine.filter((r) => !readyOf(r.id) && !waiting.includes(r)).length;
    const onlyFiles = waiting.length > 0;
    // the files to come: the family's not found, and the official file of each model input with nothing to pick
    const comingUrls = new Set([
      ...toCome(f.id).map((x) => x.get!.url),
      ...mine.flatMap((r) => (statusOf(r.id)?.emptyInputs ?? []).flatMap((id) => { const i = r.inputs.find((x) => x.id === id); return i?.type === "model" ? officialFiles(info, i.folder, i.slot).slice(0, 1).map((o) => o.url) : []; })),
    ]);
    const coming = onlyFiles ? [...comingUrls] : [];
    const comingBytes = coming.reduce((n, u) => n + sizeOf(u), 0);
    // every family starts folded, its head saying what it lacks: opened on its own when something was missing, a new install
    // (every family on, nothing downloaded yet) showed them all open, a page of text and download buttons (the owner, 2026-10-23)
    const open = opened[f.id] ?? false;
    return (
      <div key={f.id} className="flex flex-col">
        <div className="flex min-h-[52px] items-center gap-3 pr-gutter hover:bg-hover">
          <button type="button" aria-expanded={open} onClick={() => setOpened({ ...opened, [f.id]: !open })} className="flex min-h-[52px] min-w-0 grow items-center gap-3 pl-gutter text-left">
            <ChevronDown size={14} className={cx("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} />
            <span className={cx("truncate font-semibold", !isOn && "text-ink-2")}>{name}</span>
            {modelHelp(f) && <Help inside title={name} text={modelHelp(f)!} />}
            <span className="shrink-0 text-xs text-ink-3">{plural(mine.length, imported ? "workflow" : "operation")}</span>
            <span className="grow" />
            {setup.data && (isOn ? (
              <span className="flex shrink-0 items-baseline gap-2 text-xs">
                {pod ? (
                  <span className="text-ink-2">fetched by the pod{podBytes(f.id) ? ` · ${size(podBytes(f.id))}` : ""}</span>
                ) : onlyFiles ? (
                  <>
                    <span className="text-ink-2">{plural(coming.length, "file")} not here{comingBytes ? ` · ${size(comingBytes)}` : ""}</span>
                    {stuck > 0 && <span className="font-semibold text-warn-ink" data-tip="These operations lack more than files (a node pack, a file of their own): open the family for what each needs">{stuck} not ready</span>}
                  </>
                ) : (
                  <>
                    {all && extras > 0 && <span className="text-ink-3">{plural(extras, "optional file")} to add</span>}
                    <span className={cx("font-semibold", all ? "text-good" : "text-warn-ink")}>{all ? "ready" : `${good} of ${mine.length} ready`}</span>
                  </>
                )}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-ink-3" data-tip={found ? undefined : `Its model files are not in ${where ?? "ComfyUI"}. Open it for what it needs and where to get each file; it turns on by itself once they are there, unless switched off by hand.`}>
                {offSaid(found)}
              </span>
            ))}
          </button>
          {/* the needed files it lacks, every one in a click: each then has its bar on its line below. Of a family left off
              (a choice, not a problem), only once opened: ten orange buttons down the folded list read as ten warnings */}
          {setup.data && !all && !pod && (isOn || open) && <DownloadAll family={f.id} recipes={mine} machine={machine?.id} />}
          {f.id in said && (
            <Chip
              tone="link"
              tip={machine ? "Set by hand on this machine. The × lets it follow the switch of every machine (All), then its files here." : "Set by hand. The × lets it follow its model files again: on when they are in ComfyUI, off when they are not."}
              onRemove={() => save.mutate(Object.fromEntries(Object.entries(said).filter(([id]) => id !== f.id)))}
              removeLabel={machine ? "Follow every machine's switch again" : "Follow its model files again"}
            >
              {isOn ? "on" : "off"} by hand
            </Chip>
          )}
          <Toggle bare on={isOn} onChange={(next) => save.mutate({ ...said, [f.id]: next })} label={where ? `${name} on ${where}` : `${name} in the model lists`} />
        </div>
        {open && (
          <div className="border-t border-line bg-raised px-gutter pt-3 pb-3.5">
            <FamilyBody family={f.id} name={f.name} help={f.help?.what} recipes={mine} machine={machine?.id} imported={imported} />
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
        status={setup.isLoading ? <span className="text-xs text-ink-3">Asking ComfyUI…</span> : pod ? <span className="font-mono text-xs text-ink-2">{on.length} on · files fetched by the pod</span> : setup.data && listed.length ? <span className={cx("font-mono text-xs", ready === listed.length ? "text-good" : "text-warn-ink")}>{readySaid(on.length, ready, listed.length)}</span> : null}
      >
        {!machine && !settings.data.allFamilies && off.length > 0 && <AllOnHint off={off.length} />}
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
          <button type="button" aria-expanded={offOpen} onClick={() => setOffOpen(!offOpen)} className="flex min-h-[40px] items-center gap-3 bg-raised px-gutter text-left text-xs text-ink-3 hover:bg-hover">
            <span className="font-bold tracking-label uppercase">{where ? "Off here" : "Off"} · {off.length}</span>
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
