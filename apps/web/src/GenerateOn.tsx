import { useRef, useState } from "react";
import { Link } from "wouter";
import { Server } from "lucide-react";
import { modelName, roughly } from "@afflatus/core";
import type { api, MachineState, RecipeInfo } from "./api";
import { useQueue } from "./data";
import { useDraftMachine } from "./draftMachine";
import { useLoadChoices } from "./loadChoices";
import { machineLabel, machineState, severalMachines } from "./machines";
import { Popover } from "./Popover";
import { settingHref } from "./screens/settings/settingsIndex";
import { cx } from "./ui";

/** The machine picked for a draft or a timeline (draftMachine.ts), when one is and it is still there; undefined: Auto. */
export function usePickedMachine(key: string | null | undefined): MachineState | undefined {
  const queue = useQueue();
  const id = useDraftMachine((s) => (key ? s.of[key] : undefined));
  return id ? severalMachines(queue.data).find((m) => m.id === id) : undefined;
}

/** A machine's name made short for the button ("Second ComfyUI" → "Second"): the label has little room. */
export const shortName = (m: MachineState) => {
  const name = machineLabel(m);
  return name.length > 14 ? name.split(/\s+/)[0]!.slice(0, 14) : name;
};

/** What a machine is doing, in a few words: its state, how many wait for it, what it holds. */
function said(m: MachineState, waiting: number, holds: boolean): string {
  const word = machineState(m);
  const state = word === "paused" ? "paused: it waits for it" : word;
  return [state, waiting > 0 && `${waiting} waiting`, holds && "holds this model"].filter(Boolean).join(" · ");
}

/** Why a machine cannot be picked for renders that make `makes`: away, or taking the other kind only. Null: it can. */
const unpickable = (m: MachineState, makes: "image" | "video") =>
  m.online === false ? "not answering"
  : m.takes !== "all" && m.takes !== makes ? `takes ${m.takes === "image" ? "pictures" : "videos"} only`
  : null;

/**
 * The last slice of Generate (a draft) and of New take (a timeline's clips), with several ComfyUIs: a machine icon that
 * picks where they render. A small list above it: Auto (the button as it always was: the machine that would end it
 * first), then each machine with what it does, what it holds and how long this would take there; one that lacks the
 * form's model, is away, or does not take this kind of render cannot be picked. A rented pod that lacks it can: it fetches
 * it first (a pod deployed with nothing could not be picked, and nothing could be sent to it). The pick stays with the
 * draft or the timeline (draftMachine.ts). With one ComfyUI, nothing.
 */
export function GenerateOn({ recipe, pickKey, whole, look, msOn, of }: {
  recipe: RecipeInfo;
  /** Where the pick is kept: a draft's id, or a timeline's key (draftMachine.ts). */
  pickKey: string;
  whole: Record<string, unknown>;
  look: Parameters<typeof api.warm>[2];
  /** What it takes on a machine, or on Auto (null); null: not known. */
  msOn(m: MachineState | null): number | null;
  /** What the pick is kept for, as the list says it. */
  of: "draft" | "timeline";
}) {
  const { lacksOn } = useLoadChoices({ recipe, input: whole, look });
  const spec = recipe.inputs.find((i) => i.type === "model");
  const file = spec && typeof whole[spec.id] === "string" ? modelName(whole[spec.id] as string) : null;
  const makes = recipe.output === "image" ? "image" : "video";
  const why = (m: MachineState) => unpickable(m, makes) ?? (lacksOn(m.id) && !m.rented ? "lacks this model" : null);
  const note = (m: MachineState) => (lacksOn(m.id) && m.rented ? "fetches this model first" : null);
  return <MachinePick pickKey={pickKey} of={of} msOn={msOn} file={file} why={why} note={note} />;
}

/**
 * The same slice beside Render all and Render picked on a timeline: where its clips render, kept for the timeline as New
 * take's is. It knows no one form: it holds against a machine what holds for every clip (away, or pictures only), and
 * what `blocked` says of the clips to render (one it cannot render: its files not there).
 */
export function RenderOn({ pickKey, msOn, blocked }: { pickKey: string; msOn(m: MachineState | null): number | null; blocked?(m: MachineState): string | null }) {
  return <MachinePick pickKey={pickKey} of="timeline" msOn={msOn} file={null} why={(m) => unpickable(m, "video") ?? blocked?.(m) ?? null} note={() => null} small />;
}

function MachinePick({ pickKey, of, msOn, file, why, note, small }: {
  pickKey: string;
  of: "draft" | "timeline";
  /** What it takes on each machine (its own figure: machines.ts timeOn), and on Auto (null). */
  msOn(m: MachineState | null): number | null;
  file: string | null;
  /** Why a machine cannot be picked; null: it can. */
  why(m: MachineState): string | null;
  /** A word said of a machine that can be picked, in place of what it does (a pod fetching the model first). */
  note(m: MachineState): string | null;
  /** The slice of a smaller button (the timeline's header). */
  small?: boolean;
}) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const picked = usePickedMachine(pickKey);
  const set = useDraftMachine((s) => s.set);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!several.length) return null;
  const waitingOn = (id: string) => (queue.data?.waiting ?? []).filter((w) => w.machine === id || w.pinned === id).length;
  const pick = (id: string | null) => {
    set(pickKey, id);
    setOpen(false);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={of === "draft" ? "Generate on a machine of your choosing" : "Render on a machine of your choosing"}
        data-tip={picked ? `${of === "draft" ? "Generates" : "Its clips render"} on ${machineLabel(picked)}: click to pick another, or Auto` : `${of === "draft" ? "Generate" : "Render"} on a machine of your choosing`}
        onClick={() => setOpen(!open)}
        // the header's slice (small) sits beside plain buttons (the timeline's one coral button is the inspector's): edged as they are
        className={cx(
          "flex shrink-0 items-center justify-center",
          small ? "h-10 w-9 rounded-r-control border border-l-0 border-line-strong text-ink-2 hover:bg-hover hover:text-ink" : "h-11 w-11 rounded-r-lg border-l border-accent-ink/25 bg-accent text-accent-ink hover:brightness-95",
          open && (small ? "bg-hover" : "brightness-90"),
        )}
      >
        <Server size={small ? 15 : 16} />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label={of === "draft" ? "Generate on" : "Render on"} width={440} height={80 + (several.length + 1) * 52}>
          <div className="flex flex-col text-[13px]">
            <div className="flex items-baseline gap-2 px-3.5 py-2.5">
              <span className="font-semibold">{of === "draft" ? "Generate on" : "Render on"}</span>
              <span className="text-xs text-ink-3">{of === "draft" ? "this draft" : "every clip of this timeline"}</span>
            </div>
            {[null, ...several].map((m) => {
              const off = m ? why(m) : null;
              const on = m ? picked?.id === m.id : !picked;
              const holds = Boolean(m && file && m.model && m.model.toLowerCase() === file);
              const ms = msOn(m);
              const time = ms ? `~${roughly(ms)}` : "";
              return (
                <button
                  key={m?.id ?? "auto"}
                  type="button"
                  disabled={Boolean(off)}
                  onClick={() => pick(m?.id ?? null)}
                  className={cx("grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line px-3.5 py-2.5 text-left", on ? "bg-accent-wash/50" : "hover:bg-hover", off && "opacity-55")}
                >
                  {m ? <span className={cx("size-[7px] rounded-full", m.online === false ? "bg-warn" : m.paused ? "bg-ink-3" : m.running ? "bg-accent" : "border-[1.5px] border-good")} /> : <Server size={13} className="text-accent" />}
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{m ? machineLabel(m) : "Auto"}</span>{" "}
                    <span className="text-xs text-ink-3">· {m ? off ?? note(m) ?? said(m, waitingOn(m.id), holds) : "the machine that ends it first"}</span>
                  </span>
                  {off === "lacks this model" ? (
                    <Link href={`/settings/models?machine=${encodeURIComponent(m!.id)}`} onClick={() => setOpen(false)} className="text-xs text-ink-3 hover:text-ink hover:underline">Models ›</Link>
                  ) : (
                    <span className="font-mono text-xs text-ink-2">{time}</span>
                  )}
                </button>
              );
            })}
            <div className="border-t border-line px-3.5 py-2 text-[11.5px] text-ink-3">
              Kept for this {of} until you set Auto again. <Link href={settingHref("comfy.machines")} onClick={() => setOpen(false)} className="hover:text-ink hover:underline">Machines ›</Link>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
