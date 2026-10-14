import { useMutation, useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ArrowLeft, PersonStanding, Sun, Wand2 } from "lucide-react";
import type { ClipValue, InputSpec } from "@afflatus/core";
import { api, type Asset } from "./api";
import type { MenuItem } from "./ContextMenu";
import { useEntities, useRecipes } from "./data";
import { useOpenNewDraft } from "./draft";
import { useFormTarget } from "./formTarget";
import { queryKeys } from "./queryKeys";
import { useFormAim } from "./recipeForm/formAim";
import { useSayFailed } from "./sayFailed";
import { LookBar } from "./LookBar";
import { Button } from "./ui";

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

/** An Edit draft made for a Motion transfer draft: which one, and the slot its picture goes into. Kept in this browser. */
interface Link {
  motion: string;
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

/** Opens the Edit form for a picture of `motion`'s, tied to it: the source, the person, the words, how many. */
function useOpenEditFor() {
  const recipes = useRecipes();
  const openNew = useOpenNewDraft();
  const tie = useMotionLinks((s) => s.tie);
  return async (link: Link, o: { source: string; person: string | null; prompt: string; count: number; name: string }) => {
    const editor = recipes.data?.recipes.find((r) => r.id === EDITOR);
    if (!editor) throw new Error("Qwen Image 2.1 · Edit is not among the models.");
    const refs = editor.inputs.find((i) => i.type === "references");
    const source = editor.inputs.find((i) => i.type === "image" && i.role === "source")!;
    const prompt = editor.inputs.find((i) => i.type === "prompt")!;
    const d = await api.createDraft({
      recipe: editor.id, count: o.count, name: o.name,
      forms: { [editor.id]: { [source.id]: o.source, [prompt.id]: o.prompt, ...(refs && o.person ? { [refs.id]: [{ asset: o.person, role: "person" }] } : {}) } },
    });
    tie(d.id, link);
    // without a person it opens on the empty reference slot: who goes in is what is missing
    useFormAim.getState().set(editor.id, refs && !o.person && o.prompt === REPLACE ? refs.id : prompt.id);
    openNew(d);
  };
}

/**
 * Under an empty Picture slot of a Motion transfer form whose driving video is chosen: "Make it from the driving video…".
 * The cast's first person goes into the frame where the part starts; without one, the Edit form opens without a person.
 */
export function MakeFromDriving({ specs, values }: { specs: readonly InputSpec[]; values: Record<string, unknown> }) {
  const target = useFormTarget((s) => s.target);
  const entities = useEntities();
  const openEdit = useOpenEditFor();
  const failed = useSayFailed({ id: "motion-picture" });
  const slots = motionSlots(specs);
  const driving = slots ? (values[slots.driving.id] as ClipValue | undefined) : undefined;
  const start = slots?.driving.window ? Number(values[slots.driving.window.start] ?? 0) : 0;
  const first = target?.look?.cast[0];
  const person = first ? entities.data?.items.find((e) => e.id === first.id && e.kind === "person") : undefined;
  const face = person && person.kind === "person" ? person.def.pictures[0] ?? null : null;
  const make = useMutation({
    mutationFn: async () => {
      const frame = await api.frame(driving!.asset, Math.round(start * 1000));
      const motion = target!.draftId!;
      const own = await api.draft(motion);
      await openEdit({ motion, slot: slots!.picture.id }, {
        source: frame.id, person: face, prompt: REPLACE, count: 3,
        name: `Picture for ${own.name || "Motion transfer"}`,
      });
    },
    onError: failed("The picture could not be started"),
  });
  if (!slots || !driving || values[slots.picture.id] || !target?.draftId) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2.5">
      <span className="text-xs font-semibold">No picture yet? Make one from the driving video</span>
      {/* who goes into it: the only thing the cast is for on this form (the models themselves take no reference picture) */}
      {target.setLook && <LookBar people look={target.look ?? null} onChange={target.setLook} title="Who goes in" />}
      <Button size="sm" onClick={() => make.mutate()} disabled={make.isPending} className="self-start">
        <Wand2 size={14} /> Make it from the driving video…
      </Button>
      <span className="text-xs text-ink-2">
        {face && person
          ? <>{person.name} put into the frame at <span className="font-semibold text-ink">{start.toFixed(1)} s</span>, where the part starts: 3 pictures with Qwen Image 2.1 · Edit, you pick one.</>
          : <>The frame at {start.toFixed(1)} s in Qwen Image 2.1 · Edit, opened on its References: drop a photo of who goes in there, or pick them above.</>}
      </span>
    </div>
  );
}

/** Over an Edit draft made for a Motion transfer: what it is for, how its pictures go back, and the way back. */
export function MotionPictureBanner({ draftId }: { draftId: string | undefined }) {
  const link = useMotionLinks((s) => (draftId ? s.of[draftId] : undefined));
  const motion = useQuery({ queryKey: queryKeys.drafts.one(link?.motion ?? null), queryFn: () => api.draft(link!.motion), enabled: Boolean(link) });
  const openNew = useOpenNewDraft();
  if (!link) return null;
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
  const use = useMutation({
    mutationFn: async (asset: Asset) => {
      const d = await api.draft(link!.motion);
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
