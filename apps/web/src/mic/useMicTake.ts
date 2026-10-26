import { useCallback, useEffect, useRef, useState } from "react";
import { canRecord } from "../secureContext";
import { CLIPS, evenly, LEVELS, levelOf, LIVE_BARS, proposedTrim, type Level, type Reading, type Trim } from "./take";

/**
 * The microphone as the record dialog uses it: the browser's own pieces (getUserMedia, MediaRecorder, Web Audio's
 * AnalyserNode for the live waveform and the level), one take at a time. Nothing leaves the page here: the take is handed
 * to the dialog, which sends it to the user's own Afflatus when it is used or saved.
 */

/** A take once stopped: what the recorder made, how long it is, its levels and the trim proposed for it. */
export interface Take {
  blob: Blob;
  url: string;
  seconds: number;
  levels: Level[];
  proposed: Trim | null;
}

export type MicPhase = { at: "ready" } | { at: "asking" } | { at: "recording" } | { at: "listen"; take: Take };

/** A microphone of this computer, as the picker lists it. */
export interface MicDevice {
  id: string;
  label: string;
}

/** The microphone picked last, kept in this browser. */
const DEVICE_KEY = "afflatus.mic";

function storedDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** How long "Too loud: it clips" stays after the last sample that clipped, in ms. */
const CLIP_HOLD = 1500;

/** Why the microphone could not be had, in words the person can act on. */
export function micRefusal(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The browser was refused the microphone. Allow it with the mark next to the address (the padlock or the microphone icon), then Record again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in, then Record again.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone could not be opened: another app may be holding it, or the system refuses it.";
  return `The microphone could not be opened: ${err instanceof Error ? err.message : String(err)}`;
}

/** Why the browser, given the microphone, could not record it (its MediaRecorder refused). */
const recorderRefusal = (err: unknown) => `The browser could not record the microphone: ${err instanceof Error ? err.message : String(err)}`;

/** The recorder's type: webm/opus where the browser makes it (Chrome, Firefox), else its own. */
function recorderType(): string | undefined {
  const wanted = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return typeof MediaRecorder.isTypeSupported === "function" ? wanted.find((t) => MediaRecorder.isTypeSupported(t)) : undefined;
}

/** The microphone let go of: its tracks stopped (its mark in the tab goes out) and the waveform's context closed. */
function letGo(stream: MediaStream, context: AudioContext | null) {
  for (const t of stream.getTracks()) t.stop();
  void context?.close().catch(() => {});
}

export function useMicTake() {
  const here = canRecord();
  const [phase, setPhase] = useState<MicPhase>({ at: "ready" });
  const [error, setError] = useState<string | null>(null);
  // the live take: its last levels (the waveform, LIVE_BARS at most), its time, its last level and when it last clipped
  const [live, setLive] = useState<{ levels: Level[]; seconds: number; level: Level; clippedAt: number }>({ levels: [], seconds: 0, level: { peak: 0, db: -90 }, clippedAt: -Infinity });
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [device, setDeviceState] = useState(storedDevice);

  // what one recording holds while it runs: torn down whole by `close`
  const run = useRef<{ stream: MediaStream; context: AudioContext | null; recorder: MediaRecorder; tick: ReturnType<typeof setInterval> | null; readings: Reading[]; started: number; keep: boolean } | null>(null);
  const shownUrl = useRef<string | null>(null);
  // whether the dialog is still open: the browser's question about the microphone may be answered after it closed
  const open = useRef(true);

  const listDevices = useCallback(async () => {
    if (!here || typeof navigator.mediaDevices.enumerateDevices !== "function") return;
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const mics = all.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
    // before the browser is given the microphone the labels are empty: numbered then
    setDevices(mics.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
  }, [here]);

  useEffect(() => {
    if (!here) return;
    void listDevices();
    const md = navigator.mediaDevices;
    md.addEventListener?.("devicechange", listDevices);
    return () => md.removeEventListener?.("devicechange", listDevices);
  }, [here, listDevices]);

  const close = useCallback(() => {
    const r = run.current;
    if (!r) return;
    run.current = null;
    if (r.tick) clearInterval(r.tick);
    letGo(r.stream, r.context);
  }, []);

  const forget = useCallback(() => {
    if (shownUrl.current) URL.revokeObjectURL?.(shownUrl.current);
    shownUrl.current = null;
  }, []);

  // the microphone is let go of, and the take's address freed, when the dialog closes
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      if (run.current) run.current.keep = false;
      close();
      forget();
    };
  }, [close, forget]);

  const setDevice = (id: string) => {
    setDeviceState(id);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // not kept: the browser's own choice next time
    }
  };

  const start = useCallback(async () => {
    if (!here || run.current) return;
    setError(null);
    forget();
    setPhase({ at: "asking" });
    let stream: MediaStream;
    const picked = devices.some((d) => d.id === device) ? device : "";
    try {
      // the voice as the microphone hears it: the browser's echo cancelling, noise suppression and gain riding colour the
      // voice a model learns from, and the gain would hide a take that clips
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(picked ? { deviceId: { exact: picked } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (err) {
      setError(micRefusal(err));
      setPhase({ at: "ready" });
      return;
    }
    // the dialog closed while the browser asked (Esc during its question): the microphone is let go of at once, or it would
    // record on, its mark lit in the tab, until the page is left
    if (!open.current) {
      letGo(stream, null);
      return;
    }
    // given the microphone, the browser names them now
    void listDevices();
    const type = recorderType();
    const chunks: Blob[] = [];
    let context: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      context = new AudioContext();
      // made after the browser's question, so no longer in the click that asked: Safari holds such a context suspended
      if (context.state === "suspended") void context.resume().catch(() => {});
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
    } catch {
      // no Web Audio: it records all the same, with no waveform drawn as it goes
      void context?.close().catch(() => {});
      context = null;
      analyser = null;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch (err) {
      letGo(stream, context);
      setError(recorderRefusal(err));
      setPhase({ at: "ready" });
      return;
    }
    const r = { stream, context, recorder, tick: null as ReturnType<typeof setInterval> | null, readings: [] as Reading[], started: performance.now(), keep: true };
    run.current = r;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const seconds = (performance.now() - r.started) / 1000;
      close();
      if (!r.keep) return;
      // lost before anything was recorded: nothing to listen to (why stays said above)
      if (!chunks.length) {
        setPhase({ at: "ready" });
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      const url = URL.createObjectURL(blob);
      shownUrl.current = url;
      const levels = evenly(r.readings, seconds);
      setPhase({ at: "listen", take: { blob, url, seconds, levels, proposed: proposedTrim(levels, seconds) } });
    };
    // a microphone unplugged while it records: said, and the take kept as far as it goes (it ends where the sound was lost).
    // A track the page stops does not end this way: only the device going does
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (!r.keep) return;
      setError("The microphone went away while recording: the take ends where it was lost. Plug it back in to record again.");
      if (recorder.state !== "inactive") recorder.stop();
      else close();
    });
    const buffer = analyser ? new Float32Array(analyser.fftSize) : null;
    // timed, not counted: a busy PC or a hidden tab runs the timer late (a hidden one once a second), and the take's levels
    // are spread back on an even grid from these times (evenly). Not requestAnimationFrame: a hidden tab never runs it
    r.tick = setInterval(() => {
      const level = analyser && buffer ? (analyser.getFloatTimeDomainData(buffer), levelOf(buffer)) : { peak: 0, db: -90 };
      const at = performance.now();
      r.readings.push({ at: (at - r.started) / 1000, level });
      // the waveform draws the last LIVE_BARS: those alone are handed on, never the whole take at every reading
      setLive((was) => ({ levels: [...was.levels.slice(1 - LIVE_BARS), level], seconds: (at - r.started) / 1000, level, clippedAt: level.peak >= CLIPS ? at : was.clippedAt }));
    }, 1000 / LEVELS);
    setLive({ levels: [], seconds: 0, level: { peak: 0, db: -90 }, clippedAt: -Infinity });
    try {
      recorder.start();
    } catch (err) {
      r.keep = false;
      close();
      setError(recorderRefusal(err));
      setPhase({ at: "ready" });
      return;
    }
    setPhase({ at: "recording" });
  }, [here, devices, device, close, forget, listDevices]);

  /** Stop: the take is listened to. */
  const stop = useCallback(() => {
    const r = run.current;
    if (r && r.recorder.state !== "inactive") r.recorder.stop();
  }, []);

  /** Cancel a take being recorded, or let go of the one listened to: back to Ready. */
  const drop = useCallback(() => {
    const r = run.current;
    if (r) {
      r.keep = false;
      if (r.recorder.state !== "inactive") r.recorder.stop();
      else close();
    }
    forget();
    setPhase({ at: "ready" });
  }, [close, forget]);

  const clipping = phase.at === "recording" && performance.now() - live.clippedAt < CLIP_HOLD;
  return { here, phase, error, live, clipping, devices, device: devices.some((d) => d.id === device) ? device : "", setDevice, start, stop, drop };
}
