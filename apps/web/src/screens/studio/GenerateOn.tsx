import { useRef, useState } from "react";
import { Link } from "wouter";
import { Server } from "lucide-react";
import { modelName, roughly } from "@afflatus/core";
import type { Draft, MachineState, RecipeInfo } from "../../api";
import { useQueue } from "../../data";
import { useDraftMachine } from "../../draftMachine";
import { useLoadChoices } from "../../loadChoices";
import { machineLabel, severalMachines } from "../../machines";
import { Popover } from "../../Popover";
import { settingHref } from "../settings/settingsIndex";
import { cx } from "../../ui";

/** The draft's machine, when one is picked and still there; undefined: Auto. */
export function usePickedMachine(draft: Draft | null): MachineState | undefined {
  const queue = useQueue();
  const id = useDraftMachine((s) => (draft ? s.of[draft.id] : undefined));
  return id ? severalMachines(queue.data).find((m) => m.id === id) : undefined;
}

/** A machine's name made short for the button ("Second ComfyUI" → "Second"): the label has little room. */
export const shortName = (m: MachineState) => {
  const name = machineLabel(m);
  return name.length > 14 ? name.split(/\s+/)[0]!.slice(0, 14) : name;
};

/** What a machine is doing, in a few words: its state, how many wait for it, what it holds. */
function said(m: MachineState, waiting: number, holds: boolean): string {
  const state = m.online === false ? "offline" : m.paused ? "paused: it waits for it" : m.running ? "rendering" : "idle";
  return [state, waiting > 0 && `${waiting} waiting`, holds && "holds this model"].filter(Boolean).join(" · ");
}

/**
 * Generate's last slice, with several ComfyUIs: a machine icon that picks where this draft renders. A small list above
 * it: Auto (the button as it always was: the machine that would end it first), then each machine with what it does,
 * what it holds and how long this would take there; one that lacks the form's model, is away, or does not take this kind
 * of render cannot be picked. The pick stays with the draft (draftMachine.ts). With one ComfyUI, nothing.
 */
export function GenerateOn({ recipe, draft, whole, ms }: { recipe: RecipeInfo; draft: Draft; whole: Record<string, unknown>; ms: number | null }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const picked = usePickedMachine(draft);
  const set = useDraftMachine((s) => s.set);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { lacksOn } = useLoadChoices({ recipe, input: whole, look: draft.look });
  if (!several.length) return null;
  const spec = recipe.inputs.find((i) => i.type === "model");
  const file = spec && typeof whole[spec.id] === "string" ? modelName(whole[spec.id] as string) : null;
  const makes = recipe.output === "image" ? "image" : "video";
  const waitingOn = (id: string) => (queue.data?.waiting ?? []).filter((w) => w.machine === id || w.pinned === id).length;
  const why = (m: MachineState) =>
    m.online === false ? "not answering"
    : lacksOn(m.id) ? "lacks this model"
    : m.takes !== "all" && m.takes !== makes ? `takes ${m.takes === "image" ? "pictures" : "videos"} only`
    : null;
  const pick = (id: string | null) => {
    set(draft.id, id);
    setOpen(false);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Generate on a machine of your choosing"
        data-tip={picked ? `Generates on ${machineLabel(picked)}: click to pick another, or Auto` : "Generate on a machine of your choosing"}
        onClick={() => setOpen(!open)}
        className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-r-lg border-l border-accent-ink/25 bg-accent text-accent-ink hover:brightness-95", open && "brightness-90")}
      >
        <Server size={16} />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="Generate on" width={440} height={80 + (several.length + 1) * 52}>
          <div className="flex flex-col text-[13px]">
            <div className="flex items-baseline gap-2 px-3.5 py-2.5">
              <span className="font-semibold">Generate on</span>
              <span className="text-xs text-ink-3">this draft</span>
            </div>
            {[null, ...several].map((m) => {
              const off = m ? why(m) : null;
              const on = m ? picked?.id === m.id : !picked;
              const holds = Boolean(m && file && m.model && m.model.toLowerCase() === file);
              const time = ms ? `~${roughly(m ? ms * (m.pace ?? 1) : ms)}` : "";
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
                    <span className="text-xs text-ink-3">· {m ? off ?? said(m, waitingOn(m.id), holds) : "the machine that ends it first"}</span>
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
              Kept for this draft until you set Auto again. <Link href={settingHref("comfy.machines")} onClick={() => setOpen(false)} className="hover:text-ink hover:underline">Machines ›</Link>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
