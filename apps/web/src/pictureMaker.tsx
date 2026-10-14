import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ImagePlus, RefreshCw, Sparkles, X } from "lucide-react";
import { api, thumbUrl } from "./api";
import { useEntities, useQueue, useRecipes } from "./data";
import { DRAG_TYPE } from "./dragging";
import { clock } from "./format";
import { Picker } from "./PictureField";
import { useSayFailed } from "./sayFailed";
import { Bar, Button, cx, Toggle } from "./ui";

/**
 * The picture a Motion transfer moves, made for the user (the owner's ask, 2026-10-14; mock "Make the picture"): who goes
 * in (their photos, dropped or from the cast), a frame of the driving video, and one button. Three jobs of
 * qwen21.motion-picture, each putting the person into the frame and relighting it into its light, shown as they land; the
 * one clicked becomes the Picture, Reroll makes three more. The same box in Create's Motion transfer forms (SCAIL-2, Wan
 * Animate 2) and the timeline's Source panel. Each set is kept per form in this browser (`key`: a draft, a timeline source).
 */

/** The recipe that makes one: the frame with the person put in, then relit (packages/recipes qwen21). */
export const MAKER = "qwen21.motion-picture";
/** How many a round makes: the picture varies a lot by seed (1 of 3 great, 1 ruined, on the meme). */
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
  const queue = useQueue();
  const q = queue.data;
  const live = new Set([...(q?.waiting ?? []).map((w) => w.id), ...(q?.running ? [q.running.id] : []), ...(q?.machines ?? []).flatMap((m) => (m.running ? [m.running.id] : []))]);
  const pending = ids.some((id) => live.has(id));
  const history = useQuery({
    queryKey: ["picture-set-jobs", ids.join(",")],
    queryFn: () => api.jobs({ limit: 100 }),
    enabled: ids.length > 0,
    // read again while one of them is still under way, and once when the last ends
    refetchInterval: pending ? 4000 : false,
  });
  return ids.map((id) => {
    const running = q?.running?.id === id ? q.running : (q?.machines ?? []).map((m) => m.running).find((r) => r?.id === id);
    if (running) return { id, state: "running" as const, progress: running.progress ?? 0 };
    if (q?.waiting.some((w) => w.id === id)) return { id, state: "waiting" as const };
    const h = history.data?.items.find((x) => x.id === id);
    if (h?.status === "done") return { id, state: "done" as const, picture: h.made.find((m) => m.kind === "image" && !m.inBin)?.id ?? null };
    if (h) return { id, state: "failed" as const, why: h.error ?? h.status };
    return { id, state: "waiting" as const };
  });
}

export function PictureMaker({ keyId, video, atMs, name, cast, current, onPick, frameControl, after }: {
  /** What the set is kept under: a draft, a timeline's source. */
  keyId: string;
  /** The driving video, and the moment of it the person is put into. */
  video: string;
  atMs: number;
  /** What it is for, in the jobs' names ("Picture for Timeline 15"). */
  name: string;
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
  const ready = recipes.data?.recipes.some((r) => r.id === MAKER);
  const people = (cast ?? []).map((id) => entities.data?.items.find((e) => e.id === id && e.kind === "person")).filter((e) => e && e.kind === "person");
  const jobs = useJobsOf(set.jobs);
  const make = useMutation({
    mutationFn: async () => {
      const frame = await api.frame(video, Math.round(atMs));
      const made = await api.enqueue(MAKER, { source: frame.id, people: set.people.map((asset) => ({ asset, role: "person" })), relight: set.relight }, ROUND, null, { label: name });
      change(keyId, { jobs: [...set.jobs, ...made.ids] });
    },
    onError: failed("The pictures could not be started"),
  });
  const addPhoto = (id: string) => !set.people.includes(id) && set.people.length < 3 && change(keyId, { people: [...set.people, id] });
  const busy = jobs.some((j) => j.state === "waiting" || j.state === "running");
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-dashed border-line-strong px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles size={13} className="text-accent" /> Make the picture</span>

      {/* who goes in: their photos, the first the most important */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-2">Who goes in <span className="text-ink-3">· 1 to 3 photos: one sharp, front-facing, well lit; another angle helps</span></span>
        <div className="flex flex-wrap items-center gap-1.5">
          {set.people.map((id) => (
            <span key={id} className="relative">
              <img src={thumbUrl(id)} alt="" className="h-14 w-14 rounded-md object-cover" />
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
                const id = e.dataTransfer.getData(DRAG_TYPE);
                if (/^[0-9a-f]{32}$/.test(id)) addPhoto(id);
              }}
              className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line-strong text-[10px] text-ink-2 hover:text-ink"
            >
              <ImagePlus size={15} />
              photo
            </button>
          )}
          {people.map((p) => p && p.kind === "person" && p.def.pictures.length > 0 && (
            <Button key={p.id} size="sm" onClick={() => change(keyId, { people: [...new Set([...set.people, ...p.def.pictures])].slice(0, 3) })} data-tip={`${p.name}'s photos, from the cast`}>
              + {p.name}
            </Button>
          ))}
        </div>
      </div>

      {/* the frame they are put into */}
      <div className="flex items-start gap-2.5">
        <img src={`/api/assets/${video}/peek?at=${Math.round(atMs)}&h=160`} alt="" className="h-20 shrink-0 rounded-md bg-raised object-cover" />
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <span className="text-xs text-ink-2">The frame at <span className="font-mono font-semibold text-ink">{clock(atMs, { decimals: 1 })}</span>: pick one where the person is seen well, facing the camera.</span>
          {frameControl}
        </div>
      </div>

      <Toggle on={set.relight} onChange={(relight) => change(keyId, { relight })} label="Relight" note="a second pass into the frame's light: the look that blended best on the meme test" />

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
          {[...jobs].reverse().map((j) => (
            <div key={j.id} className="flex flex-col gap-1">
              {j.state === "done" && j.picture ? (
                <button type="button" onClick={() => onPick(j.picture!)} data-tip="Use this one as the Picture" className={cx("overflow-hidden rounded-md border-2", current === j.picture ? "border-accent" : "border-transparent hover:border-line-strong")}>
                  <img src={thumbUrl(j.picture)} alt="" className="aspect-[9/16] w-full object-cover" />
                </button>
              ) : (
                <div className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-1.5 rounded-md bg-raised px-2 text-center text-[10.5px] text-ink-3">
                  {j.state === "running" ? <><span>making…</span><Bar value={j.progress * 100} /></> : j.state === "failed" ? <span className="text-warn-ink">failed: {j.why}</span> : <span>queued</span>}
                </div>
              )}
              {j.state === "done" && current === j.picture && <span className="text-center text-[10.5px] font-semibold text-accent">the Picture</span>}
            </div>
          ))}
        </div>
      )}
      {after}
      {adding && <Picker title="A photo of who goes in" onClose={() => setAdding(false)} onPick={(id) => { addPhoto(id); setAdding(false); }} />}
    </div>
  );
}
