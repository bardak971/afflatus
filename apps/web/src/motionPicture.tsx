import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ArrowLeft, PersonStanding, Sun } from "lucide-react";
import type { ClipValue, InputSpec } from "@afflatus/core";
import { api, type Asset } from "./api";
import type { MenuItem } from "./ContextMenu";
import { useRecipes } from "./data";
import { useOpenNewDraft } from "./draft";
import { useFormTarget } from "./formTarget";
import { queryKeys } from "./queryKeys";
import { useFormAim } from "./recipeForm/formAim";
import { useSayFailed } from "./sayFailed";
import { PictureMaker, usePictureSets } from "./pictureMaker";
import { Slider } from "./Slider";

/**
 * Motion transfer's picture made from its driving video (HANDOVER-swap-lipsync-plan.md §9, the meme test): the frame where the
 * driving video's part starts, with the cast's first person put into it by an Edit model, then picked by eye. Not made and
 * animated in one go: the picture decides the result and varies a lot by seed (1 of 3 great, 1 ruined on the meme), and it
 * costs a minute against six for the video. So the Edit form opens filled for three pictures, its drafts are tied to the
 * Motion transfer draft they are for, and a picked one goes back into its Picture slot.
 */

/** The Edit model it opens: Qwen Image 2.1's, which kept Nicolas's face best on the meme (0.95 to 0.96, Klein 4B 0.66 to 0.77). */
const EDITOR = "qwen21.edit";
/** What it is asked: the words that worked on the meme, the person and the light in one. The highlighted "who" is the user's to change. */
const REPLACE =
  "Replace the main person in <image1> with the person in <image2>: their face, their hair, their beard and their skin. " +
  "They are lit exactly like the rest of <image1>: the same light and shadows on the face, the same soft, grainy phone-video look, so that they belong in the picture. " +
  "Keep everything else in <image1> exactly the same: their clothes, their pose, the people around them and the framing.";
/** The second pass that brought him into the room's red on the meme (0.87, the best look), on one picked picture. */
const RELIGHT =
  "Relight only the main person in <image1> so that they match the rest of the picture: the same light as on the people and the room around them, " +
  "the same shadows on their face, less light on their skin where the room is dark, and the same soft, grainy phone-video look. " +
  "Do not change their face, their hair, their expression or anything else in <image1>.";

/**
 * An Edit draft made for a Motion transfer: a draft of Create (`motion`), or a timeline's source lane (`timeline`), and the
 * slot its picture goes into. Kept in this browser.
 */
interface Link {
  motion?: string;
  timeline?: string;
  slot: string;
}
export const useMotionLinks = create<{ of: Record<string, Link>; tie(edit: string, link: Link): void }>()(
  persist((set) => ({ of: {}, tie: (edit, link) => set((s) => ({ of: { ...s.of, [edit]: link } })) }), { name: "afflatus.motion-picture" }),
);

/** A Motion transfer form: a picture that moves and a driving video of which a part is taken. */
export function motionSlots(inputs: readonly InputSpec[]): { picture: InputSpec; driving: Extract<InputSpec, { type: "clip" }> } | null {
  const picture = inputs.find((i) => i.type === "image" && i.role === "source");
  const driving = inputs.find((i): i is Extract<InputSpec, { type: "clip" }> => i.type === "clip" && i.role === "source" && Boolean(i.window));
  return picture && driving ? { picture, driving } : null;
}

/** Opens the Edit form for a picture of `motion`'s, tied to it (or for a timeline's source: not tied): the source, the person, the words, how many. */
function useOpenEditFor() {
  const recipes = useRecipes();
  const openNew = useOpenNewDraft();
  const tie = useMotionLinks((s) => s.tie);
  return async (link: Link | null, o: { source: string; person: string | null; prompt: string; count: number; name: string }) => {
    const editor = recipes.data?.recipes.find((r) => r.id === EDITOR);
    if (!editor) throw new Error("Qwen Image 2.1 · Edit is not among the models.");
    const refs = editor.inputs.find((i) => i.type === "references");
    const source = editor.inputs.find((i) => i.type === "image" && i.role === "source")!;
    const prompt = editor.inputs.find((i) => i.type === "prompt")!;
    const d = await api.createDraft({
      recipe: editor.id, count: o.count, name: o.name,
      forms: { [editor.id]: { [source.id]: o.source, [prompt.id]: o.prompt, ...(refs && o.person ? { [refs.id]: [{ asset: o.person, role: "person" }] } : {}) } },
    });
    if (link) tie(d.id, link);
    // without a person it opens on the empty reference slot: who goes in is what is missing
    useFormAim.getState().set(editor.id, refs && !o.person && o.prompt === REPLACE ? refs.id : prompt.id);
    openNew(d);
  };
}

/**
 * Under the Picture of a Motion transfer form whose driving video is chosen (SCAIL-2, Wan Animate 2, in Create): the picture
 * made for the user (pictureMaker.tsx), its frame chosen within the driving video's part, the cast's people offered as who
 * goes in. Shown while there is no Picture, and after one was made here (to pick another, or reroll).
 */
export function MakeFromDriving({ specs, values, current, onPick }: { specs: readonly InputSpec[]; values: Record<string, unknown>; current: string | null; onPick(asset: string): void }) {
  const target = useFormTarget((s) => s.target);
  const slots = motionSlots(specs);
  const driving = slots ? (values[slots.driving.id] as ClipValue | undefined) : undefined;
  const start = slots?.driving.window ? Number(values[slots.driving.window.start] ?? 0) : 0;
  const seconds = slots?.driving.window ? Number(values[slots.driving.window.seconds] ?? 5) : 5;
  const [at, setAt] = useState<number | null>(null);
  const made = usePictureSets((s) => (target?.draftId ? (s.of[`draft:${target.draftId}`]?.jobs.length ?? 0) > 0 : false));
  if (!slots || !driving || !target?.draftId || (current && !made)) return null;
  const frame = Math.max(start, Math.min(start + seconds, at ?? start));
  return (
    <PictureMaker
      keyId={`draft:${target.draftId}`}
      video={driving.asset}
      atMs={frame * 1000}
      name="Picture for Motion transfer"
      cast={target.look?.cast.map((c) => c.id)}
      current={current}
      onPick={onPick}
      frameControl={<Slider label="Frame" value={frame} min={start} max={start + seconds} step={0.1} unit=" s" onChange={setAt} />}
    />
  );
}

/** Over an Edit draft made for a Motion transfer: what it is for, how its pictures go back, and the way back. */
export function MotionPictureBanner({ draftId }: { draftId: string | undefined }) {
  const link = useMotionLinks((s) => (draftId ? s.of[draftId] : undefined));
  const motion = useQuery({ queryKey: queryKeys.drafts.one(link?.motion ?? null), queryFn: () => api.draft(link!.motion!), enabled: Boolean(link?.motion) });
  const timeline = useQuery({ queryKey: queryKeys.timelines.one(link?.timeline ?? ""), queryFn: () => api.timeline(link!.timeline!), enabled: Boolean(link?.timeline) });
  const openNew = useOpenNewDraft();
  const [, go] = useLocation();
  if (!link) return null;
  if (link.timeline) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-3 py-2 text-xs text-ink">
        <PersonStanding size={14} className="shrink-0 text-accent" />
        <span className="grow">
          For the source of <span className="font-semibold">{timeline.data?.name || "a timeline"}</span>: right-click the picture you like, <span className="font-semibold">Use for Motion transfer</span>, or <span className="font-semibold">Relight it first…</span>
        </span>
        <button type="button" onClick={() => go(`/timelines/${link.timeline}`)} className="flex shrink-0 items-center gap-1 font-semibold underline underline-offset-2">
          <ArrowLeft size={12} /> Back
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-3 py-2 text-xs text-ink">
      <PersonStanding size={14} className="shrink-0 text-accent" />
      <span className="grow">
        For <span className="font-semibold">{motion.data?.name || "a Motion transfer draft"}</span>: right-click the picture you like, <span className="font-semibold">Use for Motion transfer</span>.
      </span>
      {motion.data && (
        <button type="button" onClick={() => openNew(motion.data!)} className="flex shrink-0 items-center gap-1 font-semibold underline underline-offset-2">
          <ArrowLeft size={12} /> Back
        </button>
      )}
    </div>
  );
}

/** A picture's menu lines while its Edit draft is tied to a Motion transfer: put it in, or relight it first. */
export function useMotionPictureItems(): (asset: Asset) => MenuItem[] {
  const draftId = useFormTarget((s) => s.target?.draftId);
  const link = useMotionLinks((s) => (draftId ? s.of[draftId] : undefined));
  const openNew = useOpenNewDraft();
  const openEdit = useOpenEditFor();
  const failed = useSayFailed({ id: "motion-picture" });
  const client = useQueryClient();
  const [, go] = useLocation();
  const use = useMutation({
    mutationFn: async (asset: Asset) => {
      // a timeline's source: its Picture, then back to the timeline
      if (link!.timeline) {
        const t = await api.timeline(link!.timeline);
        await api.editTimeline(t.id, { source: { inputs: { ...(t.source?.inputs ?? {}), [link!.slot]: asset.id } } });
        await client.invalidateQueries({ queryKey: queryKeys.timelines.one(t.id) });
        go(`/timelines/${t.id}`);
        return;
      }
      const d = await api.draft(link!.motion!);
      const saved = await api.saveDraft(d.id, { forms: { ...d.forms, [d.recipe]: { ...d.forms[d.recipe], [link!.slot]: asset.id } } });
      openNew(saved);
    },
    onError: failed("The picture could not be put in its Motion transfer"),
  });
  const relight = useMutation({
    mutationFn: (asset: Asset) => openEdit(link!, { source: asset.id, person: null, prompt: RELIGHT, count: 2, name: "Picture relit for Motion transfer" }),
    onError: failed("The relight could not be started"),
  });
  return (asset) =>
    link && asset.kind === "image" && !asset.inBin
      ? [
          { label: "Use for Motion transfer", icon: <PersonStanding size={14} />, note: "its picture, then back to it", run: () => use.mutate(asset) },
          { label: "Relight it first…", icon: <Sun size={14} />, note: "into the scene's light", run: () => relight.mutate(asset) },
        ]
      : [];
}
