import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Circle, Mic, Pause, Play, RotateCcw, Scissors, Square } from "lucide-react";
import { api } from "../api";
import { Dialog, DIALOG } from "../Dialog";
import { clock, seconds } from "../format";
import { Kbd, typing } from "../Keys";
import { projectForNew } from "../project";
import { queryKeys } from "../queryKeys";
import { canRecord } from "../secureContext";
import { Select } from "../Select";
import { Button, CloseButton, cx, ErrorNote, IconButton } from "../ui";
import { barHeight, barsOf, LIVE_BARS, takeName, trimSaid, type Trim } from "./take";
import { useMicTake, type Take } from "./useMicTake";

/**
 * Record a voice from the microphone into a sound slot (the mic mock, 2026-10-26): the 🎙 every sound slot has beside it
 * (a form's recording or voice sample, the Prompt kit person's voice, the recording lane), and the dialog it opens. One
 * take at a time: Record, Listen, Retake if it is not right, Trim the silence (proposed, never done on its own), then Use
 * it (into the slot it was opened from) or Save to the library (kept, nothing filled). The take goes only to the user's
 * own Afflatus, which keeps it as a WAV.
 */

/** What the 🎙 of a slot says when the page cannot have the microphone (opened by its LAN address over http). */
const NOT_HERE = "🎙 needs this computer or https: open Afflatus on the PC it runs on.";

/**
 * The 🎙 beside a sound slot. Greyed where the page cannot have the microphone, and a click then says why in the dialog
 * rather than nothing happening. `slot`: the slot's name, in the dialog's title and the take's name; `kit`: a take used
 * goes with the Prompt kit's person, as a file dropped there does, not into the library.
 */
export function MicButton({ slot, kit, onTake, size = 28, className }: { slot: string; kit?: boolean; onTake(asset: string): void; size?: 24 | 28 | 32 | 36; className?: string }) {
  const [open, setOpen] = useState(false);
  // whether the page is a secure one does not change while it is open
  const [here] = useState(canRecord);
  return (
    <>
      <IconButton
        size={size} tone="outline" label={`Record from the microphone: ${slot}`} tip={here ? "Record from the microphone" : NOT_HERE}
        data-mic="" aria-disabled={here ? undefined : true} onClick={() => setOpen(true)} className={cx(!here && "opacity-40", className)}
      >
        <Mic size={size <= 28 ? 14 : 16} />
      </IconButton>
      {open && <MicDialog slot={slot} kit={kit} onTake={onTake} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The record dialog, opened from a slot's 🎙 or a lane's menu. */
export function MicDialog({ slot, kit, onTake, onClose }: { slot: string; kit?: boolean; onTake(asset: string): void; onClose(): void }) {
  const mic = useMicTake();
  const client = useQueryClient();
  const { phase } = mic;
  const take = phase.at === "listen" ? phase.take : null;
  // the trim being looked at (proposed, its edges dragged) and the one kept: nothing is cut until it is kept
  const [trimming, setTrimming] = useState<Trim | null>(null);
  const [kept, setKept] = useState<Trim | null>(null);
  useEffect(() => {
    setTrimming(null);
    setKept(null);
  }, [take]);
  const player = usePlayer(take);

  // closed while the take is being sent (Esc, the ×): the upload is given up on, and an answer that comes all the same
  // fills nothing (a mutation's own callbacks run after its dialog is gone)
  const closed = useRef(false);
  const sending = useRef<AbortController | null>(null);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      sending.current?.abort();
    };
  }, []);
  const send = useMutation({
    mutationFn: async ({ use }: { use: boolean }) => {
      const file = new File([take!.blob], takeName(slot, new Date()), { type: take!.blob.type || "audio/webm" });
      const asked = { take: kept ? { trim: kept } : {} };
      const stop = new AbortController();
      sending.current = stop;
      return { use, asset: await api.upload(file, { ...(use && kit ? { kit: true } : { project: projectForNew() }), ...asked, signal: stop.signal }) };
    },
    onSuccess: ({ use, asset }) => {
      // a take that reached the library before the upload could be given up on is listed there, and nothing more
      if (!(use && kit)) void client.invalidateQueries({ queryKey: queryKeys.assets.all() });
      if (closed.current) return;
      if (use) onTake(asset.id);
      onClose();
    },
    onSettled: () => {
      sending.current = null;
    },
  });

  const record = () => void mic.start();
  const retake = () => {
    player.stop();
    mic.drop();
    void mic.start();
  };
  const fillSlot = () => take && !send.isPending && send.mutate({ use: true });
  const keepTrim = () => {
    setKept(trimming);
    setTrimming(null);
    player.stop();
  };

  // Space, R, Enter as the buttons say; Esc is the dialog's (onEscape below). Not while a list is open over the dialog, and
  // Enter and Space not on a control holding the focus (Save to the library, Undo the trim, the ×, the microphone's list):
  // the focus says what is meant there. The buttons these keys stand for (Record, Stop, Use it) keep them
  const keys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  keys.current = (e) => {
    if ((e.key === " " || e.key === "Enter") && e.target instanceof Element && e.target.closest(OWN_KEYS) && !e.target.closest("[data-mic-key]")) return false;
    if (e.key === " ") {
      if (phase.at === "ready") record();
      else if (phase.at === "recording") mic.stop();
      else if (take) player.toggle(trimming ?? kept);
      else return false;
      return true;
    }
    if ((e.key === "r" || e.key === "R") && take && !send.isPending) retake();
    else if (e.key === "Enter" && take && !trimming) fillSlot();
    else return false;
    return true;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e) || document.querySelector("[role=listbox], [role=menu]")) return;
      if (keys.current(e)) {
        // the key does what it says here, not also what the focused button does
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Esc: a recording is cancelled, a trim looked at is undone; else the dialog closes (and the take with it)
  const onEscape = () => {
    if (phase.at === "recording") mic.drop();
    else if (trimming) {
      setTrimming(null);
      player.stop();
    } else return false;
    return true;
  };

  const showPicker = mic.here && mic.devices.length > 1;
  // the level, as the bars draw it: on the dB scale a voice reads on, not the sample's own
  const meter = barHeight(mic.live.level.peak);
  return (
    <Dialog label={`Record a voice for ${slot}`} onClose={onClose} onEscape={onEscape} z="z-50" className={DIALOG.replace("max-w-md", "max-w-3xl")}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control bg-accent-wash text-accent"><Mic size={16} /></span>
        <span className="flex min-w-0 grow flex-col gap-px">
          <h2 className="m-0 truncate text-base font-bold">Record a voice</h2>
          <span className="truncate text-xs text-ink-3">for {slot}</span>
        </span>
        {showPicker && (
          <div className="w-64 shrink-0">
            <Select
              label="Microphone" size="sm" icon={<Mic size={13} />} disabled={phase.at === "recording" || phase.at === "asking"}
              value={mic.device} options={[{ value: "", label: "The system's microphone" }, ...mic.devices.map((d) => ({ value: d.id, label: d.label }))]} onChange={mic.setDevice}
            />
          </div>
        )}
        <CloseButton data-dialog-close="" keys="Esc" onClose={onClose} />
      </div>

      {!mic.here ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-4" data-mic-off="">
          <span className="font-semibold">The microphone can't be used from this address.</span>
          <span className="text-sm text-ink-2">
            Browsers give the microphone only to secure pages (https) or to this computer (127.0.0.1). This page is open at {location.origin}. Open Afflatus on the PC it runs on, or record elsewhere and drop the file.
          </span>
        </div>
      ) : (
        <>
          <Wave mic={mic} take={take} now={player.now} trimming={trimming} kept={kept} onTrim={setTrimming} />
          <div className="flex min-h-8 items-center gap-3">
            <span className="min-w-[92px] font-mono text-xl text-ink-strong" data-mic-time="">
              {take ? `${tenths(player.now ?? 0)} / ${tenths(take.seconds)}` : tenths(phase.at === "recording" ? mic.live.seconds : 0)}
            </span>
            {phase.at === "recording" && (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs text-warn-ink"><span aria-hidden className="size-2 rounded-full bg-warn motion-safe:animate-rec-blink" />Recording</span>
                <span className="relative h-2 grow overflow-hidden rounded bg-raised" role="meter" aria-label="Level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter}>
                  {/* green, amber near the top, red where it clips */}
                  <span className={cx("absolute inset-y-0 left-0", meter >= 88 ? "bg-warn" : meter >= 70 ? "bg-attention" : "bg-good")} style={{ width: `${meter}%` }} />
                </span>
                <span className="min-w-40 text-xs text-warn-ink" role="status">{mic.clipping ? "Too loud: it clips" : ""}</span>
              </>
            )}
            {take && kept && !trimming && <span className="text-xs text-ink-2">Trimmed: {seconds((kept.to - kept.from) * 1000)} kept</span>}
          </div>
          {trimming && take && <span className="text-sm text-ink-2"><Scissors size={13} className="mr-1.5 inline" />{trimSaid(trimming, take.seconds)} Drag either edge to adjust.</span>}
          {(mic.error ?? send.error?.message) && <ErrorNote>{mic.error ?? send.error?.message}</ErrorNote>}

          <div className="flex flex-wrap items-center gap-2">
            {/* each step its own buttons (keyed): a button kept from one step to the next would keep the focus, Record turning
                into Stop then into Listen, and Enter would play the take rather than use it */}
            {phase.at === "ready" || phase.at === "asking" ? (
              <Fragment key="ready">
                <Button tone="primary" onClick={record} disabled={phase.at === "asking"} autoFocus data-mic-key=""><Circle size={12} className="fill-current" />Record <Kbd>Space</Kbd></Button>
                <span className="text-sm text-ink-2">{phase.at === "asking" ? "Waiting for the browser's microphone…" : "Press Record, then speak. Space starts and stops."}</span>
              </Fragment>
            ) : phase.at === "recording" ? (
              <Fragment key="recording">
                <Button tone="primary" onClick={mic.stop} data-mic-key=""><Square size={12} className="fill-current" />Stop <Kbd>Space</Kbd></Button>
                <Button onClick={mic.drop}>Cancel <Kbd>Esc</Kbd></Button>
              </Fragment>
            ) : trimming ? (
              <Fragment key="trimming">
                <Button onClick={() => player.toggle(trimming)}>{player.playing ? <Pause size={13} /> : <Play size={13} />}Listen to the trimmed take <Kbd>Space</Kbd></Button>
                <Button tone="primary" onClick={keepTrim}>Keep the trim</Button>
                <Button onClick={() => { setTrimming(null); player.stop(); }}>Undo the trim</Button>
                <Button onClick={retake} className="ml-auto"><RotateCcw size={13} />Retake <Kbd>R</Kbd></Button>
              </Fragment>
            ) : take ? (
              <Fragment key="listen">
                <Button onClick={() => player.toggle(kept)}>{player.playing ? <Pause size={13} /> : <Play size={13} />}Listen <Kbd>Space</Kbd></Button>
                <Button onClick={retake} disabled={send.isPending}><RotateCcw size={13} />Retake <Kbd>R</Kbd></Button>
                {kept ? (
                  <Button onClick={() => setKept(null)} disabled={send.isPending}>Undo the trim</Button>
                ) : (
                  // not while the take is sent: what is sent is the take as it was when Use it or Save was pressed
                  <Button disabled={!take.proposed || send.isPending} data-tip={take.proposed ? "Proposes a cut of the silence at both ends: nothing is cut until it is kept" : "No silence at either end to trim"} onClick={() => { player.stop(); setTrimming(take.proposed); }}>
                    <Scissors size={13} />Trim the silence
                  </Button>
                )}
                <span className="ml-auto flex gap-2">
                  <Button onClick={() => send.mutate({ use: false })} disabled={send.isPending} data-tip="Kept in the library; nothing is filled">{send.isPending && !send.variables?.use ? "Saving…" : "Save to the library"}</Button>
                  <Button tone="primary" onClick={fillSlot} disabled={send.isPending} data-mic-key="">{send.isPending && send.variables?.use ? "Adding…" : "Use it"} <Kbd>Enter</Kbd></Button>
                </span>
              </Fragment>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** A time of the take as the dialog shows it, from seconds: 0:04.7. */
const tenths = (s: number) => clock(s * 1000, { decimals: 1 });

/** What takes Enter and Space for itself while it holds the focus. */
const OWN_KEYS = "button, a[href], input, select, textarea, [role=button], [role=combobox], [role=checkbox], [role=switch], [role=radio], [role=tab]";

/** The take played in the page, from where to where: the whole of it, or the trim. `now`: the playhead, in seconds. */
function usePlayer(take: Take | null) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    audio.current?.pause();
    setPlaying(false);
  };
  useEffect(() => {
    setNow(take ? 0 : null);
    if (!take) return;
    const el = new Audio(take.url);
    audio.current = el;
    return () => {
      if (tick.current) clearInterval(tick.current);
      tick.current = null;
      el.pause();
      audio.current = null;
      setPlaying(false);
    };
  }, [take]);
  const play = (range: Trim | null) => {
    const el = audio.current;
    if (!el || !take) return;
    const from = range?.from ?? 0;
    const to = range?.to ?? take.seconds;
    el.currentTime = from;
    setNow(from);
    setPlaying(true);
    Promise.resolve(el.play()).catch(() => setPlaying(false));
    tick.current = setInterval(() => {
      const at = el.currentTime;
      setNow(at);
      if (at >= to || el.ended) {
        stop();
        setNow(Math.min(to, take.seconds));
      }
    }, 40);
  };
  return { now, playing, stop, toggle: (range: Trim | null) => (playing ? stop() : play(range)) };
}

/** The bars the whole take is drawn with. */
const TAKE_BARS = 180;
/** The shortest part a trim keeps, in seconds. */
const TRIM_LEAST = 0.3;

/**
 * The waveform: growing as the take is recorded, then the whole take with its playhead; the trim looked at hatched at
 * both ends with an edge to drag (or move with the arrow keys), the one kept hatched without.
 */
function Wave({ mic, take, now, trimming, kept, onTrim }: {
  mic: ReturnType<typeof useMicTake>;
  take: Take | null;
  now: number | null;
  trimming: Trim | null;
  kept: Trim | null;
  onTrim(trim: Trim): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const recording = mic.phase.at === "recording";
  const bars = take ? barsOf(take.levels, TAKE_BARS) : recording ? mic.live.levels.slice(-LIVE_BARS).map((l) => barHeight(l.peak)) : [];
  const total = take?.seconds ?? 0;
  const shown = trimming ?? kept;
  const at = (s: number) => `${(Math.max(0, Math.min(total, s)) / (total || 1)) * 100}%`;
  const headAt = take && now !== null ? now / (total || 1) : null;

  const move = (edge: "from" | "to", s: number) => {
    if (!trimming) return;
    const v = Math.round(s * 100) / 100;
    onTrim(edge === "from" ? { from: Math.max(0, Math.min(v, trimming.to - TRIM_LEAST)), to: trimming.to } : { from: trimming.from, to: Math.min(total, Math.max(v, trimming.from + TRIM_LEAST)) });
  };
  const drag = (edge: "from" | "to") => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    const toS = (x: number) => ((x - r.left) / (r.width || 1)) * total;
    const target = e.currentTarget;
    const over = (ev: PointerEvent) => move(edge, toS(ev.clientX));
    const up = () => {
      target.removeEventListener("pointermove", over);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", over);
    target.addEventListener("pointerup", up);
  };
  const nudge = (edge: "from" | "to") => (e: ReactKeyboardEvent) => {
    if (!trimming || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const step = (e.shiftKey ? 0.5 : 0.1) * (e.key === "ArrowLeft" ? -1 : 1);
    move(edge, trimming[edge] + step);
  };

  return (
    <div ref={box} className={cx("relative flex h-[150px] items-center overflow-hidden rounded-xl border border-line bg-ground", take ? "gap-px" : "gap-[2px]")} data-mic-wave={take ? "take" : recording ? "live" : "empty"}>
      {bars.length === 0 && <span className="absolute inset-0 grid place-items-center text-sm text-ink-3">{recording ? "Listening…" : "The waveform shows here as you speak."}</span>}
      {bars.map((h, k) => (
        <i key={k} className={cx("rounded-sm", take ? "min-w-px flex-1" : "w-[3px] shrink-0", !take || (headAt !== null && k / bars.length < headAt) ? "bg-accent" : "bg-ink-3")} style={{ height: `${h}%` }} />
      ))}
      {take && shown && (
        <>
          <div aria-hidden className={cx("absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,rgba(0,0,0,.6)_0_5px,rgba(0,0,0,.35)_5px_10px)]", trimming && "border-r-2 border-attention")} style={{ width: at(shown.from) }} />
          <div aria-hidden className={cx("absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,rgba(0,0,0,.6)_0_5px,rgba(0,0,0,.35)_5px_10px)]", trimming && "border-l-2 border-attention")} style={{ width: `calc(100% - ${at(shown.to)})` }} />
        </>
      )}
      {take && trimming && (["from", "to"] as const).map((edge) => (
        <div
          key={edge} role="slider" tabIndex={0} aria-label={edge === "from" ? "Where the trimmed take starts" : "Where the trimmed take ends"}
          aria-valuemin={0} aria-valuemax={Math.round(total * 100) / 100} aria-valuenow={trimming[edge]} aria-valuetext={`${trimming[edge].toFixed(2)} s`}
          onPointerDown={drag(edge)} onKeyDown={nudge(edge)}
          className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize outline-none focus-visible:bg-attention/30" style={{ left: at(trimming[edge]) }}
        />
      ))}
      {headAt !== null && <span aria-hidden className="absolute inset-y-0 w-0.5 bg-ink-strong" style={{ left: `${Math.min(1, headAt) * 100}%` }} />}
    </div>
  );
}
