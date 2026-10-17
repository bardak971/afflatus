import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { api, type Machine } from "../../api";
import { useFamilies, useRecipes, useSettings, useSetup } from "../../data";
import { plural } from "../../format";
import { machineLabel } from "../../machines";
import { DownloadTo } from "../../useGetFile";
import { Chip, cx, ErrorNote, Help, Toggle } from "../../ui";
import { Block, Card } from "./Rows";
import { DownloadAll, FamilyBody } from "./ModelsFamily";
import { modelHelp } from "../../modelHelp";
import { queryKeys } from "../../queryKeys";

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
  const listed = recipes.data.recipes.filter((r) => families.offers(r));
  const ready = listed.filter((r) => readyOf(r.id)).length;

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
          {/* the needed files it lacks, every one in a click: each then has its bar on its line below. Of a family left off
              (a choice, not a problem), only once opened: ten orange buttons down the folded list read as ten warnings */}
          {setup.data && !all && (isOn || open) && <DownloadAll family={f.id} recipes={mine} machine={machine?.id} />}
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
          <div className="border-t border-line bg-raised px-[18px] pt-3 pb-3.5">
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
