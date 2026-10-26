import { useCallback, useEffect, useRef, useState } from "react";
import { canRecord } from "../secureContext";
import { CLIPS, LEVELS, levelOf, proposedTrim, type Level, type Trim } from "./take";

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

/** The recorder's type: webm/opus where the browser makes it (Chrome, Firefox), else its own. */
function recorderType(): string | undefined {
  const wanted = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return typeof MediaRecorder.isTypeSupported === "function" ? wanted.find((t) => MediaRecorder.isTypeSupported(t)) : undefined;
}

export function useMicTake() {
  const here = canRecord();
  const [phase, setPhase] = useState<MicPhase>({ at: "ready" });
  const [error, setError] = useState<string | null>(null);
  // the live take: its levels so far (the waveform), its time, its last level and when it last clipped
  const [live, setLive] = useState<{ levels: Level[]; seconds: number; level: Level; clippedAt: number }>({ levels: [], seconds: 0, level: { peak: 0, db: -90 }, clippedAt: -Infinity });
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [device, setDeviceState] = useState(storedDevice);

  // what one recording holds while it runs: torn down whole by `close`
  const run = useRef<{ stream: MediaStream; context: AudioContext | null; recorder: MediaRecorder; tick: ReturnType<typeof setInterval> | null; levels: Level[]; started: number; keep: boolean } | null>(null);
  const shownUrl = useRef<string | null>(null);

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
    for (const t of r.stream.getTracks()) t.stop();
    void r.context?.close().catch(() => {});
  }, []);

  const forget = useCallback(() => {
    if (shownUrl.current) URL.revokeObjectURL?.(shownUrl.current);
    shownUrl.current = null;
  }, []);

  // the microphone is let go of, and the take's address freed, when the dialog closes
  useEffect(() => () => {
    if (run.current) run.current.keep = false;
    close();
    forget();
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: picked ? { deviceId: { exact: picked } } : true });
    } catch (err) {
      setError(micRefusal(err));
      setPhase({ at: "ready" });
      return;
    }
    // given the microphone, the browser names them now
    void listDevices();
    const type = recorderType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    let context: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
    } catch {
      // no Web Audio: it records all the same, with no waveform drawn as it goes
      context = null;
      analyser = null;
    }
    const r = { stream, context, recorder, tick: null as ReturnType<typeof setInterval> | null, levels: [] as Level[], started: performance.now(), keep: true };
    run.current = r;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const seconds = (performance.now() - r.started) / 1000;
      close();
      if (!r.keep) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      const url = URL.createObjectURL(blob);
      shownUrl.current = url;
      setPhase({ at: "listen", take: { blob, url, seconds, levels: r.levels, proposed: proposedTrim(r.levels, seconds) } });
    };
    // a microphone unplugged while it records: said, and the take so far dropped (it ends where the sound was lost)
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (run.current !== r) return;
      r.keep = false;
      setError("The microphone went away while recording. Plug it back in, then Record again.");
      setPhase({ at: "ready" });
      if (recorder.state !== "inactive") recorder.stop();
      else close();
    });
    const buffer = analyser ? new Float32Array(analyser.fftSize) : null;
    r.tick = setInterval(() => {
      const level = analyser && buffer ? (analyser.getFloatTimeDomainData(buffer), levelOf(buffer)) : { peak: 0, db: -90 };
      r.levels.push(level);
      const at = performance.now();
      setLive((was) => ({ levels: [...r.levels], seconds: (at - r.started) / 1000, level, clippedAt: level.peak >= CLIPS ? at : was.clippedAt }));
    }, 1000 / LEVELS);
    setLive({ levels: [], seconds: 0, level: { peak: 0, db: -90 }, clippedAt: -Infinity });
    recorder.start();
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
