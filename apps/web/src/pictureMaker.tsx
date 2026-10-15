import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ImagePlus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { api, thumbUrl } from "./api";
import { useAsset, useEntities, useQueue, useRecipes, useSetup } from "./data";
import { Viewer } from "./viewer/LazyViewer";
import { DRAG_PICTURE, DRAG_TYPE } from "./dragging";
import { clock } from "./format";
import { Picker } from "./PictureField";
import { useSayFailed } from "./sayFailed";
import { Bar, Button, cx, Help, Toggle } from "./ui";

/**
 * The picture a Motion transfer moves, made for the user (the owner's ask, 2026-10-14; mock "Make the picture"): who goes
 * in (their photos, dropped or from the cast), a frame of the driving video, and one button. Three jobs of
 * qwen21.motion-picture, each putting the person into the frame and relighting it into its light, shown as they land; the
 * one clicked becomes the Picture, Reroll makes three more. The same box in Create's Motion transfer forms (SCAIL-2, Wan
 * Animate 2) and the timeline's Source panel. Each set is kept per form in this browser (`key`: a draft, a timeline source).
 */

/** The recipe that makes one: the frame with the person put in, then relit (packages/recipes qwen21). */
export const MAKER = "qwen21.motion-picture";
/** How many a round makes: the picture varies by seed (the face's likeness 0.64 to 0.89 over three seeds, HANDOVER-motion-picture-report.md). */
const ROUND = 3;

interface PictureSet {
  /** The photos of who goes in (library ids), the first the most important. */
  people: string[];
  relight: boolean;
  /** The jobs made for this form, oldest first. */
  jobs: string[];
}
const EMPTY: PictureSet = { people: [], relight: true, jobs: [] };
export const usePictureSets = create<{ of: Record<string, PictureSet>; set(key: string, patch: Partial<PictureSet>): void }>()(
  persist((set) => ({ of: {}, set: (key, patch) => set((s) => ({ of: { ...s.of, [key]: { ...EMPTY, ...s.of[key], ...patch } } })) }), { name: "afflatus.picture-sets" }),
);

/** Where each job of a set stands: waiting, running (how far), done (the picture it made), or failed (why). */
function useJobsOf(ids: string[]) {
  const client = useQueryClient();
  const queue = useQueue();
  const q = queue.data;
  const live = new Set([...(q?.waiting ?? []).map((w) => w.id), ...(q?.running ? [q.running.id] : []), ...(q?.machines ?? []).flatMap((m) => (m.running ? [m.running.id] : []))]);
  // which of them the queue still holds: one leaving it is read again at once (the key changes), its picture shown as it lands
  const inQueue = ids.filter((id) => live.has(id)).join(",");
  const history = useQuery({
    queryKey: ["picture-set-jobs", ids.join(","), inQueue],
    // these jobs by id: the last page of the history lost a set's jobs once others had run since (they read "queued" for ever)
    queryFn: () => api.jobs({ ids: ids.slice(-60).join(","), limit: 60 }),
    enabled: ids.length > 0,
    placeholderData: (before) => before,
    // read again while one of them has not ended in the history: every 3 s while the queue holds it; out of the queue (just
    // finished, its picture still being filed) ten more reads, 1.5 s apart, before it is taken as gone. Read only while the
    // queue held it, the last picture showed after a reload only; read for ever, a dismissed one polled every 1.5 s
    refetchInterval: (query) => {
      const ended = new Set((query.state.data?.items ?? []).map((x) => x.id));
      const open = ids.filter((id) => !ended.has(id));
      if (open.some((id) => live.has(id))) return 3000;
      return open.length && query.state.dataUpdateCount < 10 ? 1500 : false;
    },
  });
  /** Read often enough since it left the queue to say a job is gone, not just still being filed. */
  // (dataUpdatedAt read here so that each read redraws, the same answer included)
  const settled = history.dataUpdatedAt > 0 && !history.isPlaceholderData && (client.getQueryState(["picture-set-jobs", ids.join(","), inQueue])?.dataUpdateCount ?? 0) >= 10;
  return ids.map((id) => {
    const running = q?.running?.id === id ? q.running : (q?.machines ?? []).map((m) => m.running).find((r) => r?.id === id);
    if (running) return { id, state: "running" as const, progress: running.progress ?? 0 };
    if (q?.waiting.some((w) => w.id === id)) return { id, state: "waiting" as const };
    const h = history.data?.items.find((x) => x.id === id);
    if (h?.status === "done") {
      const picture = h.made.find((m) => m.kind === "image" && !m.inBin)?.id ?? null;
      // its picture taken to the bin elsewhere: said, and let go of here
      if (!picture) return { id, state: "gone" as const, why: "its picture is in the bin" };
      return { id, state: "done" as const, picture, face: h.face ?? null, copies: h.faceCopies ?? 0 };
    }
    if (h) return { id, state: "failed" as const, why: h.error ?? h.status };
    // in neither the queue nor the history after reads enough to have seen it filed: taken out of the history
    if (settled) return { id, state: "gone" as const, why: "no longer in the history" };
    return { id, state: "waiting" as const };
  });
}

export function PictureMaker({ keyId, video, atMs, name, folder, cast, current, onPick, frameControl, after }: {
  /** What the set is kept under: a draft, a timeline's source. */
  keyId: string;
  /** The driving video, and the moment of it the person is put into. */
  video: string;
  atMs: number;
  /** What it is for, in the jobs' names ("Picture for Timeline 15"). */
  name: string;
  /** Where the pictures land: the timeline's renders' folder, the folder open beside the Create form. Left out: the Inbox. */
  folder?: string | null;
  /** The cast's people (entity ids), offered as who goes in. */
  cast?: string[];
  /** The Picture now: ringed among the made ones. */
  current: string | null;
  onPick(asset: string): void;
  /** How the frame is chosen here (a slider within the part, or "the playhead"): drawn under the frame. */
  frameControl?: React.ReactNode;
  /** Under the results (the timeline's "then make the clips"). */
  after?: React.ReactNode;
}) {
  const set = usePictureSets((s) => s.of[keyId] ?? EMPTY);
  const change = usePictureSets((s) => s.set);
  const recipes = useRecipes();
  const entities = useEntities();
  const failed = useSayFailed({ id: "picture-maker" });
  const [adding, setAdding] = useState(false);
  /** A made picture shown large (a click on it); Use picks it. */
  const [looking, setLooking] = useState<string | null>(null);
  const shown = useAsset(looking);
  // the recipe there, and its files and nodes found in ComfyUI (the built-in recipes are always listed): a machine without
  // Qwen Image 2.1 said here, not three failed jobs. Before ComfyUI has answered, taken as ready
  const setup = useSetup();
  const ready = recipes.data?.recipes.some((r) => r.id === MAKER) && (setup.data?.recipes.find((r) => r.id === MAKER)?.ready ?? true);
  const source = useAsset(video);
  const people = (cast ?? []).map((id) => entities.data?.items.find((e) => e.id === id && e.kind === "person")).filter((e) => e && e.kind === "person");
  const jobs = useJobsOf(set.jobs);
  const make = useMutation({
    mutationFn: async () => {
      // a working picture, out of the library (the frame and what is made from it: only the one picked goes in), the same
      // one for the same moment again (a Reroll)
      const frame = await api.frame(video, Math.round(atMs), undefined, true, true);
      // beside the driving video when no folder is open here: not the Inbox
      const into = folder ?? source.data?.folderId ?? null;
      const made = await api.enqueue(MAKER, { source: frame.id, people: set.people.map((asset) => ({ asset, role: "person" })), relight: set.relight }, ROUND, null, { label: name, ...(into ? { folder: into } : {}) });
      // the set as it is now: a picture let go of while the frame was being made stays gone
      change(keyId, { jobs: [...(usePictureSets.getState().of[keyId]?.jobs ?? []), ...made.ids] });
    },
    onError: failed("The pictures could not be started"),
  });
  // the one picked goes into the library (kept), the rest stay working pictures of this box, gone a day on
  const pick = useMutation({
    mutationFn: async (asset: string) => {
      await api.adopt(asset);
      onPick(asset);
    },
    onError: failed("The picture could not be picked"),
  });
  const addPhotos = (ids: string[]) => change(keyId, { people: [...new Set([...set.people, ...ids])].slice(0, 3) });
  const busy = jobs.some((j) => j.state === "waiting" || j.state === "running");
  /** A made picture let go: out of the box, and to the library's bin (back from there for a week); a failed one only out of the box. */
  const drop = useMutation({
    mutationFn: async (j: (typeof jobs)[number]) => {
      // a picture a timeline still uses (a window's Picture) is only taken out of here: it stays in the library for that clip
      if (j.state === "done" && j.picture && j.picture !== current) await api.bin(j.picture).catch(() => {});
      change(keyId, { jobs: usePictureSets.getState().of[keyId]?.jobs.filter((id) => id !== j.id) ?? [] });
    },
    onError: failed("The picture could not be deleted"),
  });
  // the made ones best first by how much the face is the person (when measured), the others after, newest first. A picture
  // with the person pasted in elsewhere too comes after every clean one, whatever its figure
  const faceOf = (j: (typeof jobs)[number]) => (j.state === "done" && j.face != null ? j.face - (j.copies ? 2 : 0) : null);
  const ordered = [...jobs].reverse().sort((a, b) => (faceOf(b) ?? -2) - (faceOf(a) ?? -2));
  const best = ordered.find((j) => j.state === "done" && j.face != null && !j.copies);
  const measured = jobs.some((j) => j.state === "done" && j.face != null);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles size={13} className="text-accent" /> Make the picture</span>

      {/* who goes in: their photos, the first the most important */}
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-ink-2">Who goes in <span className="text-ink-3">· 1 to 3 photos</span><Help text="Photos of one person. The first (main) matters most: sharp and front-facing. A second from another angle helps a frame where they are turned. Every photo is named in the instruction." /></span>
        <div className="flex flex-wrap items-center gap-1.5">
          {set.people.map((id, i) => (
            <span key={id} className="relative">
              <button
                type="button"
                onClick={() => i > 0 && change(keyId, { people: [id, ...set.people.filter((x) => x !== id)] })}
                data-tip={i === 0 ? "The main photo: the one the face is taken from most. Click another to make it the main one" : "Click: make it the main photo"}
                className={cx("block overflow-hidden rounded-md border-2", i === 0 ? "border-accent" : "border-transparent hover:border-line-strong")}
              >
                <img src={thumbUrl(id)} alt="" className="h-14 w-14 object-cover" />
              </button>
              {i === 0 && set.people.length > 1 && <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded bg-accent px-1 text-[9px] font-bold text-accent-ink">main</span>}
              <button type="button" aria-label="Remove this photo" onClick={() => change(keyId, { people: set.people.filter((x) => x !== id) })} className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-ink-2 hover:text-ink">
                <X size={11} />
              </button>
            </span>
          ))}
          {set.people.length < 3 && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                // pictures only (a video or a sound made a job that failed), and every one of a drag of several
                if (!e.dataTransfer.types.includes(DRAG_PICTURE)) return;
                addPhotos(e.dataTransfer.getData(DRAG_TYPE).split(",").filter((id) => /^[0-9a-f]{32}$/.test(id)));
              }}
              className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line-strong text-[10px] text-ink-2 hover:text-ink"
            >
              <ImagePlus size={15} />
              photo
            </button>
          )}
          {people.map((p) => p && p.kind === "person" && p.def.pictures.length > 0 && (
            <Button key={p.id} size="sm" onClick={() => change(keyId, { people: p.def.pictures.slice(0, 3) })} data-tip={`${p.name}'s photos, from the cast, in place of these: one person goes in`}>
              + {p.name}
            </Button>
          ))}
        </div>
      </div>

      {/* the frame they are put into */}
      <div className="flex items-start gap-2.5">
        <img src={`/api/assets/${video}/peek?at=${Math.round(atMs)}&h=160`} alt="" className="h-20 shrink-0 rounded-md bg-raised object-cover" />
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs text-ink-2">The frame at <span className="font-mono font-semibold text-ink">{clock(atMs, { decimals: 1 })}</span><Help text="The head replaced is the main person's of this frame. Pick a moment where they are seen well, facing the camera." /></span>
          {frameControl}
        </div>
      </div>

      <Toggle on={set.relight} onChange={(relight) => change(keyId, { relight })} label="Relight" note="a second pass into the frame's light" />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" tone="primary" disabled={!ready || !set.people.length || make.isPending} onClick={() => make.mutate()}>
          {jobs.length ? <><RefreshCw size={13} /> Reroll · {ROUND} more</> : <><Sparkles size={13} /> Make {ROUND} pictures</>}
        </Button>
        {!set.people.length && <span className="text-xs text-warn-ink">Add a photo of who goes in first.</span>}
        {!ready && <span className="text-xs text-warn-ink">Qwen Image 2.1 is not among the models (Settings › Models).</span>}
        {jobs.length > 0 && !busy && <button type="button" onClick={() => change(keyId, { jobs: [] })} className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink">clear</button>}
      </div>

      {/* what came of it: as each lands; a click makes it the Picture */}
      {jobs.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {ordered.map((j) => (
            <div key={j.id} className="flex flex-col gap-1">
              {j.state === "done" && j.picture ? (
                <button type="button" onClick={() => setLooking(j.picture!)} aria-label="Show it large" className={cx("relative cursor-zoom-in overflow-hidden rounded-md border-2", current === j.picture ? "border-accent" : "border-transparent hover:border-line-strong")}>
                  <img src={thumbUrl(j.picture)} alt="" className="aspect-[9/16] w-full object-cover" />
                  {j.face != null && (j.copies ? (
                    <span
                      data-tip={`The person was pasted in ${j.copies === 1 ? "once more" : `${j.copies} more times`} beside the head replaced (or someone else was made them too): put last`}
                      className="absolute bottom-1 left-1 rounded bg-warn-wash px-1.5 py-px text-[10.5px] font-bold text-warn-ink"
                    >
                      pasted in ×{j.copies}
                    </span>
                  ) : (
                    <span
                      data-tip="How much the face where the frame's person stood is the person of the photos (ArcFace): 0.8 and up, a close likeness; under 0.5, someone else (or a face too small or turned to read)"
                      className={cx("absolute bottom-1 left-1 rounded px-1.5 py-px font-mono text-[10.5px] font-bold", j.face >= 0.8 ? "bg-good text-ground" : j.face >= 0.5 ? "bg-warn text-warn-on" : "bg-warn-wash text-warn-ink")}
                    >
                      face {j.face.toFixed(2)}{j === best ? " · best" : ""}
                    </span>
                  ))}
                </button>
              ) : (
                <div className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-1.5 rounded-md bg-raised px-2 text-center text-[10.5px] text-ink-3">
                  {j.state === "running" ? <><span>making…</span><Bar value={j.progress * 100} loading={!j.progress} /></> : j.state === "failed" ? <span className="text-warn-ink">failed: {j.why}</span> : j.state === "gone" ? <span>{j.why}</span> : <span>queued</span>}
                </div>
              )}
              {j.state === "done" && j.picture && (current === j.picture
                ? <span className="py-1 text-center text-[11px] font-semibold text-accent">the Picture</span>
                : (
                  <span className="flex gap-1">
                    <Button size="sm" className="grow" onClick={() => pick.mutate(j.picture!)} disabled={pick.isPending} data-tip="This one as the Picture: it goes into the library, the others do not">Use</Button>
                    <Button size="sm" aria-label="Delete this picture" data-tip="Delete it: out of here and to the bin (back from there for a week)" disabled={drop.isPending} onClick={() => drop.mutate(j)}><Trash2 size={13} /></Button>
                  </span>
                ))}
              {(j.state === "failed" || j.state === "gone") && <Button size="sm" onClick={() => drop.mutate(j)} data-tip="Take it out of here">Dismiss</Button>}
            </div>
          ))}
        </div>
      )}
      {after}
      {shown.data && <Viewer asset={shown.data} onClose={() => setLooking(null)} />}
      {jobs.some((j) => j.state === "done") && !measured && (
        <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
          No face figures
          <Help text="The face is measured by the Afflatus node pack's Face Match, which needs insightface in ComfyUI (pip install insightface onnxruntime, then restart ComfyUI). With it, a figure is still missing when no face could be read in the photos, or the face is too small." />
        </span>
      )}
      {adding && <Picker title="A photo of who goes in" onClose={() => setAdding(false)} onPick={(id) => { addPhotos([id]); setAdding(false); }} />}
    </div>
  );
}
