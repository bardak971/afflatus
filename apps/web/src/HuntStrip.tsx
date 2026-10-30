import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type HuntSummary, type MachineState } from "./api";
import { useQueue } from "./data";
import { cancelHunt, openDeploy } from "./deploy";
import { leftWords, plural, usd } from "./format";
import { useNow } from "./hooks";
import { firstPick, huntDone, huntStrip, huntTitle } from "./huntSaid";
import { machineLabel } from "./machines";
import { Popover } from "./Popover";
import { queryKeys } from "./queryKeys";
import { useSayFailed } from "./sayFailed";
import { Progress } from "./progress/Progress";
import { cx } from "./ui";

/**
 * The GPU hunt on the status bar, while it hunts or deploys (once its pod is up it is a machine like any): the left slot
 * when it holds the renders (`slot`: this PC rests, nothing else to say there), else a small chip after the render's,
 * as the expiring chip is. A click opens its card: where it is, the home machines, and Change or Cancel.
 */
export function HuntStrip({ hunt, slot }: { hunt: HuntSummary; slot: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // its minutes on the strip; the card's bar by the second while it is open
  const now = useNow(open ? 1000 : 30_000);
  const said = huntStrip(hunt, now);
  if (!said) return null;
  const tip = hunt.hold === "rest" ? "A GPU hunt holds the renders for the GPU it finds: click for where it is" : "A GPU hunt is under way, this PC rendering meanwhile: click for where it is";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={tip}
        onClick={() => setOpen(!open)}
        className={cx(
          "inline-flex shrink-0 items-center whitespace-nowrap transition-colors hover:brightness-125",
          slot
            ? "h-7 gap-2 rounded-lg bg-accent-wash px-2.5 outline outline-1 outline-accent"
            : "m-fade h-6 gap-1.5 rounded-full border border-accent bg-accent-wash px-2.5 text-xs font-semibold text-accent",
          open && "ring-1 ring-accent",
        )}
      >
        {slot ? (
          <>
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-accent" />
            <span className="font-semibold text-ink">{said.main}</span>
            <span className="text-ink-2">{said.more}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full border-[1.5px] border-dashed border-accent" />
            {said.chip}
          </>
        )}
      </button>
      {open && <HuntCard hunt={hunt} now={now} anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}

/** What a home machine does while the hunt is under way, for its row of the card. */
function homeSaid(m: MachineState, hunt: HuntSummary, allPaused: boolean): { said: string; right: string } {
  const paused = m.paused || allPaused;
  if (m.running) return { said: `${m.running.label} · ${Math.round(m.running.progress * 100)} %`, right: "rendering" };
  if (m.online === false) return { said: "offline", right: "" };
  if (paused && hunt.hold === "rest") return { said: "resting for the hunt: takes no render", right: "idle" };
  return { said: paused ? "paused" : "takes renders meanwhile", right: "idle" };
}

function HuntCard({ hunt, now, anchor, onClose }: { hunt: HuntSummary; now: number; anchor: React.RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const client = useQueryClient();
  const q = useQueue().data;
  const machines = (q?.machines ?? []).filter((m) => !m.rented);
  // its choices and its last ranking: read while the card is open, again with each queue event (live.ts)
  const view = useQuery({ queryKey: queryKeys.hunt(), queryFn: ({ signal }) => api.hunt({ signal }) }).data;
  const st = view?.hunt ?? null;
  const pick = firstPick(view?.ranking);
  const failed = useSayFailed({ id: "hunt", href: "/queue", go: "Open the Queue" });
  const cancel = useMutation({ mutationFn: () => cancelHunt(client), onSuccess: onClose, onError: failed("Could not cancel the hunt") });
  const where = st?.dataCenter ? ` in ${st.dataCenter}` : "";
  const line = hunt.status === "deploying"
    ? `Deploying it${where} at ${hunt.firstPick ? `${usd(hunt.firstPick.price)}/h for the GPU` : "its rate"}, with the hunt's choices. ${plural(hunt.held, "render")} wait for it.`
    : [
      pick ? `First pick now: ${pick.name}, ${pick.stock}${where}.` : view?.ranking ? "No GPU fits your choices: change the hunt." : "RunPod not asked yet.",
      st?.asks ? `RunPod asked ${plural(st.asks, "time")}.` : "",
      hunt.hold === "rest" ? `${plural(hunt.held, "render")} held for it.` : "This PC renders meanwhile; the pod joins when found and takes its share.",
    ].filter(Boolean).join(" ");
  const said = huntStrip(hunt, now);
  return (
    <Popover anchor={anchor} onClose={onClose} label="GPU hunt" width={420} height={230 + machines.length * 52}>
      <div className="flex flex-col text-body">
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <span className="flex items-center gap-2 font-bold">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
            {hunt.status === "deploying" ? said?.main : st ? huntTitle(st) : "Hunting"}
          </span>
          <span className="text-ink-2">{line}</span>
          {st?.lastError && <span className="text-warn-ink">Last answer from RunPod: {st.lastError}</span>}
          {hunt.status === "hunting" && (
            <div className="flex flex-col gap-1">
              <Progress meter value={huntDone(hunt, now)} className="h-1" radius="rounded-key" label="Hunt time gone" />
              <span className="flex justify-between font-mono text-meta text-ink-3">
                <span>{leftWords(Math.max(0, now - Date.parse(hunt.startedAt)))}</span>
                <span>gives up at {leftWords(Date.parse(hunt.giveUpAt) - Date.parse(hunt.startedAt), true)}</span>
              </span>
            </div>
          )}
        </div>
        {machines.map((m) => {
          const home = homeSaid(m, hunt, Boolean(q?.paused));
          return (
            <div key={m.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line px-3.5 py-2.5">
              <span aria-hidden className={cx("size-[7px] rounded-full", m.running ? "bg-good" : "bg-ink-3")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{machineLabel(m)}</span>
                <span className="truncate text-ink-2">{home.said}</span>
              </span>
              <span className="text-ink-3">{home.right}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button type="button" className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:bg-hover" onClick={() => { onClose(); openDeploy("change"); }}>Change the hunt…</button>
          <span className="grow" />
          {/* the pod being made is billed from its first second: it is let come up, then stopped like any */}
          <button
            type="button"
            disabled={cancel.isPending || hunt.status === "deploying"}
            data-tip={hunt.status === "deploying" ? "A GPU is being deployed for it: cancel once it is up, or stop its pod then" : undefined}
            className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:bg-hover disabled:opacity-50"
            onClick={() => cancel.mutate()}
          >
            Cancel the hunt
          </button>
        </div>
      </div>
    </Popover>
  );
}
