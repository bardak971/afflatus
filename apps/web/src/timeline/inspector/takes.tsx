import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { AudioLines, CornerDownRight, FlipHorizontal2, ImagePlus, MoreHorizontal, Play, ScanFace, Scissors, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, thumbUrl, type Asset, type Clip, type RecipeInfo, type Take, type TakeMade } from "../../api";
import { Button, Chip, CloseButton, cx, IconButton, NumberBox, Segmented } from "../../ui";
import { FieldRow } from "../../fields";
import { RangeSlider } from "../../RangeSlider";
import { DRAG_PICTURE, useDropZone } from "../../dragging";
import { projectForNew } from "../../project";
import { useSlotPaste } from "../../paste";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { PIN_WORDS, pinInputs, takeTrouble, type PinMirror, type PinWhere, type ShownPatch } from "../model";
import { pinMenuItems } from "../menus";
import { flipped, MirrorMark } from "../MirrorMark";
import { SHOWS } from "../attention";
import { cutAtJoinFigure, cutAtJoinSaid, cutsAtJoin } from "@afflatus/core";
import { useRecipes } from "../../data";
import { useTileMenu } from "../../TileMenu";
import { Viewer } from "../../viewer/LazyViewer";
import { diffWords, madeDiff, madeShown, type MadeDiff } from "../madeWith";

/**
 * A place a picture can be dropped on to become a pinned frame: one from the library, or a file from the computer, which
 * goes into the library first. Ctrl+V while the focus is in it: as a drop, a picture the library holds already used as it is.
 */
function PinDrop({ className, label, onPick, onMenu, children }: { className?: string; label: string; onPick(id: string): void; onMenu?(e: React.MouseEvent): void; children: ReactNode }) {
  const upload = useMutation({ mutationFn: ({ file, reuse }: { file: File; reuse: boolean }) => api.upload(file, { project: projectForNew(), reuse }), onSuccess: (a) => onPick(a.id) });
  const drop = useDropZone([DRAG_PICTURE], onPick, (file) => file.type.startsWith("image/") && upload.mutate({ file, reuse: false }));
  const root = useRef<HTMLDivElement>(null);
  const pasted = useSlotPaste(true, { el: () => root.current, kind: "image", label, busy: upload.isPending, take: ([file]) => upload.mutate({ file: file!, reuse: true }) });
  return (
    <div ref={root} {...drop.props} onContextMenu={onMenu} className={cx(className, drop.zone, drop.wanted && "ring-1 ring-accent/50")} data-tip={drop.wanted ? "Drop the picture here" : undefined}>
      {children}
      {upload.isPending && <span className="ml-1 text-xs text-ink-2">Adding…</span>}
      {pasted && <span role="alert" className="ml-1 text-xs text-warn-ink">{pasted}</span>}
    </div>
  );
}

/** The clip's form as it stands, which each take is compared with (card #89): the next render's settings. */
export interface FormNow {
  recipe: RecipeInfo | undefined;
  /** Its whole form, with its defaults, as a render would send it. */
  whole: Record<string, unknown>;
  /** It carries on from the clip before: its first frame is that clip's. */
  carries: boolean;
  recipes: RecipeInfo[];
  /** Use this take's settings: its form put back into the clip's (one Undo step). */
  onUse(take: Take & { made: TakeMade }): void;
}

/** How a take differs from the form now; null for a take rendered nowhere here (an import), or a form not known. */
export function takeDiff(t: Take, form: FormNow | undefined): MadeDiff | null {
  return t.made && form ? madeDiff(t.made, form, form.recipes) : null;
}

const REF_WORDS: Record<string, string> = { person: "person", place: "place", clothing: "clothes", object: "object", style: "style" };
const seconds = (s: number) => `${s.toFixed(1)} s`;

/**
 * What a take was made with, read from its own render (never the clip's form): small pictures of its pinned frames and
 * references, its voice or sound, the prompt it was sent; and, under them, how that differs from the form now.
 */
function MadeLine({ made, recipe, diff }: { made: TakeMade; recipe: RecipeInfo | undefined; diff: MadeDiff | null }) {
  if (!recipe) return null;
  const shown = madeShown(made, recipe);
  const said = diff ? diffWords(diff) : null;
  const box = "size-5 shrink-0 rounded-key bg-raised object-cover";
  return (
    <>
      <span className="flex min-w-0 items-center gap-1" data-made>
        {shown.pins.map((p) => (p.asset
          ? <span key={p.where} className="relative shrink-0" data-tip={`${p.word[0]!.toUpperCase()}${p.word.slice(1)}${p.mirrored ? " (mirrored)" : ""}`}>
              <img src={thumbUrl(p.asset)} alt={p.word} loading="lazy" className={cx(box, "ring-1 ring-accent/60", p.mirrored && "-scale-x-100")} />
              {p.mirrored && <FlipHorizontal2 size={9} aria-hidden className="absolute -right-0.5 -bottom-0.5 rounded-full bg-panel text-ink-2" />}
            </span>
          : <span key={p.where} aria-label={p.word} data-tip="First frame: the clip before's last frame, carried on" className={cx(box, "flex items-center justify-center border border-dashed border-line-strong text-ink-3")}><CornerDownRight size={11} /></span>))}
        {shown.references.map((r, k) => <img key={`${r.asset}:${k}`} src={thumbUrl(r.asset)} alt={`reference: ${REF_WORDS[r.role] ?? r.role}`} loading="lazy" data-tip={`Reference: ${REF_WORDS[r.role] ?? r.role}`} className={box} />)}
        {shown.sounds.map((x) => (
          <span key={x.asset} aria-label={x.word} data-tip={`${x.word[0]!.toUpperCase()}${x.word.slice(1)}${x.part ? `, ${seconds(x.part.start)} to ${seconds(x.part.start + x.part.seconds)}` : ""}`} className={cx(box, "flex items-center justify-center text-ink-2")}><AudioLines size={12} /></span>
        ))}
        {shown.prompt && <span className="min-w-0 truncate text-meta text-ink-3" data-tip={`Prompt sent: ${shown.prompt.length > 600 ? `${shown.prompt.slice(0, 600)}…` : shown.prompt}`}>{shown.prompt}</span>}
      </span>
      {said && <span className="text-meta text-attention-ink" data-tip={`How this take was made against the form as it stands, which is the next render's settings${diff?.settings.length ? ` (${diff.settings.join(", ")})` : ""}. Its ··· menu has Use this take's settings.`}>{said}</span>}
    </>
  );
}

/** How the takes after the one that plays are listed: the newest first, the smoothest joins, the face closest to its person's. */
type TakeSort = "newest" | "smoothest" | "face";

/**
 * A clip's takes, one per row: the one that plays first (the heading says "take 11 of 11 plays", and its row was under ten
 * others), then the rest in the order picked. Hovered, a take is previewed in the player; clicked, it plays. Each says
 * its length, how its joins jump and its face figure on a meta line under its name, and its "···" (or a right-click)
 * offers the library's actions on its video (Download, Keep, Compare…) after the take's own (Face refine, Remove).
 */
export function TakeList({ clip, take, joinOf, smoothest, form, onPreview, onPatch, onRemoveTake, onFacePass, onRetake }: {
  clip: Clip;
  take: Take | null;
  joinOf(take: string): { in: number | null; out: number | null } | undefined;
  /** The take whose joins jump least, once measured. */
  smoothest: string | null;
  /** The clip's form now, which each take says it was made with or not; left out, the takes do not say. */
  form?: FormNow;
  onPreview(take: Take | null): void;
  onPatch(patch: ShownPatch): void;
  onRemoveTake(id: string): void;
  /** A Face refine of this take alone, as a new take (the mock's takes): only where the clip's model offers it. */
  onFacePass?(take: Take): void;
  /** Render a new take of the clip, offered beside a take that cut at the join; left out while it cannot render. */
  onRetake?(): void;
}) {
  // past ×3 the join shows, as Needs a look counts it
  const bad = (v: number) => v > SHOWS;
  // how much each take's face is its person's (Face Match, measured after the render): the closest marked when two or more
  // were measured, to pick from, never rendered again by itself (the owner: no automatic retries; card #18)
  const faced = clip.takes.filter((t) => t.measure?.face != null);
  const closest = faced.length > 1 ? faced.reduce((best, t) => (t.measure!.face! > best.measure!.face! ? t : best)).id : null;
  // takes made with more than one form (a source's form changed in place, its takes kept): each says its own
  const recipes = useRecipes();
  const forms = new Set(clip.takes.map((t) => t.recipe).filter(Boolean));
  const formOf = (t: Take) => (forms.size > 1 && t.recipe ? recipes.data?.recipes.find((r) => r.id === t.recipe)?.title ?? null : null);
  // a take's worst join, for the smoothest first; one not measured goes last
  const worst = (t: Take) => {
    const j = joinOf(t.id);
    const both = [j?.in, j?.out].filter((v): v is number => v != null);
    return both.length ? Math.max(...both) : Infinity;
  };
  const measured = clip.takes.filter((t) => worst(t) !== Infinity).length;
  // a sort is offered once it would tell two takes apart; each take keeps its number (the order it was made in)
  const sorts: Array<{ value: TakeSort; label: string }> = [
    { value: "newest", label: "Newest" },
    ...(measured > 1 ? [{ value: "smoothest" as const, label: "Smoothest" }] : []),
    ...(faced.length > 1 ? [{ value: "face" as const, label: "Closest face" }] : []),
  ];
  const [picked, setSort] = useState<TakeSort>("newest");
  const sort = sorts.some((s) => s.value === picked) ? picked : "newest";
  const numbered = clip.takes.map((t, i) => ({ t, i }));
  const rest = numbered.filter(({ t }) => t.id !== take?.id);
  const sorted =
    sort === "smoothest" ? [...rest].sort((a, b) => worst(a.t) - worst(b.t) || b.i - a.i)
    : sort === "face" ? [...rest].sort((a, b) => (b.t.measure?.face ?? -2) - (a.t.measure?.face ?? -2))
    : [...rest].reverse();
  const listed = [...numbered.filter(({ t }) => t.id === take?.id), ...sorted];
  const numberOf = (id: string | null) => Math.max(1, clip.takes.findIndex((x) => x.id === id) + 1);
  // a take's video, open in the viewer: the arrows step through the clip's takes, so Compare sets two of them side by side
  const [viewing, setViewing] = useState<Asset | null>(null);
  const menu = useTileMenu({
    onOpen: setViewing,
    // the viewer's keys do not act in the inspector: the menu's keys act in the menu only
    place: "shelf",
    form: false,
    // the take's Remove takes its video to the bin with it, and Undo brings both back: the library's own bin is left out
    omit: ["bin"],
    first: (asset) => {
      const at = numbered.find(({ t }) => t.asset.id === asset.id);
      if (!at) return [];
      const { t } = at;
      const trouble = takeTrouble(t, clip.takes);
      return [
        ...(t.id !== take?.id ? [{ label: "Play this take", icon: <Play size={14} />, run: () => onPatch({ take: t.id }) }] : []),
        ...(onFacePass && !t.facePass && !trouble ? [{ label: "Face refine", icon: <ScanFace size={14} />, note: "as a new take", run: () => onFacePass(t) }] : []),
        ...(form && t.made && takeDiff(t, form) && diffWords(takeDiff(t, form)!) ? [{ label: "Use this take's settings", icon: <SlidersHorizontal size={14} />, note: "into the form · Undo takes it back", run: () => form.onUse(t as Take & { made: TakeMade }) }] : []),
      ];
    },
    // the take's Remove in the bin's place: last, alone, as every menu's destructive row
    last: (asset) => {
      const at = numbered.find(({ t }) => t.asset.id === asset.id);
      return at ? [{ label: `Remove take ${at.i + 1}`, icon: <Trash2 size={14} />, danger: true, run: () => onRemoveTake(at.t.id) }] : [];
    },
  });
  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
      {sorts.length > 1 && (
        <span className="flex justify-end px-1.5 pb-1">
          <Segmented<TakeSort> label="Sort the takes" size="sm" oneLine value={sort} onChange={setSort} options={sorts} />
        </span>
      )}
      {listed.map(({ t, i }) => {
        const on = t.id === take?.id;
        const j = joinOf(t.id);
        const trouble = takeTrouble(t, clip.takes);
        const plays = t.endMs - t.startMs;
        const file = t.asset.durationMs ?? 0;
        const trimmed = !trouble && (t.trimStartMs > 0 || t.trimEndMs > 0);
        // the thumbnail at the take's own shape, 54 px on its long side
        const w = t.asset.width ?? 0;
        const h = t.asset.height ?? 0;
        const thumb = w && h ? (h >= w ? { width: Math.max(24, Math.round((54 * w) / h)), height: 54 } : { width: 54, height: Math.max(24, Math.round((54 * h) / w)) }) : { width: 34, height: 54 };
        return (
          <div
            key={t.id}
            className={cx("group/take flex items-center rounded-control", on ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : "hover:bg-hover")}
            onMouseEnter={() => !on && onPreview(t)}
            onMouseLeave={() => onPreview(null)}
            onContextMenu={(e) => menu.open(e, t.asset)}
          >
            <button
              type="button"
              aria-pressed={on}
              aria-label={on ? `Take ${i + 1}, the one that plays` : `Play take ${i + 1} instead`}
              data-tip={on ? undefined : "Click to make it play (hovered, it previews)"}
              onFocus={() => !on && onPreview(t)}
              onBlur={() => onPreview(null)}
              onClick={() => {
                onPreview(null);
                if (!on) onPatch({ take: t.id });
              }}
              className="flex min-w-0 grow items-center gap-2.5 p-1.5 text-left"
            >
              <img src={thumbUrl(t.asset.id)} alt="" loading="lazy" style={thumb} className="shrink-0 rounded-md bg-raised object-cover" />
              <span className="flex min-w-0 grow flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-title font-bold">Take {i + 1}</span>
                  {on && <Chip size="xs" tone="accent">plays</Chip>}
                  {trouble && <Chip size="xs" tone="warn" tip={trouble}>broken</Chip>}
                  {t.finishedFrom && !trouble && (t.facePass
                    ? <Chip size="xs" tone="good" tip={`Take ${numberOf(t.finishedFrom)}'s own frames, its faces redrawn closer to the person's picture (Face refine), nothing else changed`}>face refine of take {numberOf(t.finishedFrom)}</Chip>
                    : <Chip size="xs" tone="good" tip={`The finished version of take ${numberOf(t.finishedFrom)}: the same clip, brought to its final quality (${t.asset.width} × ${t.asset.height})`}>finished</Chip>)}
                  {smoothest === t.id && clip.takes.length > 1 && <Chip size="xs" tip="The smoothest joins of the takes">smoothest</Chip>}
                  {closest === t.id && <Chip size="xs" tip="The face closest to its person's picture, of the takes measured">closest face</Chip>}
                  {formOf(t) && <Chip size="xs" tip="The form it was rendered with: this clip's takes come from more than one">{formOf(t)}</Chip>}
                  {cutsAtJoin(t.measure) && <Chip size="xs" tone="attention" tip={`Seamless, but ${cutAtJoinSaid(t.measure!)}.`}>cut at the join · {cutAtJoinFigure(t.measure!)}</Chip>}
                </span>
                {/* the figures, a step under the name: how long it plays (a trimmed take says so), its joins, its face */}
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-meta text-ink-3">
                  <span className={cx("flex items-center gap-1", trouble && "text-warn-ink")} data-tip={trimmed && file > plays ? `Trimmed: plays ${(plays / 1000).toFixed(1)} of its ${(file / 1000).toFixed(1)} s` : undefined}>
                    {trimmed && <Scissors size={11} aria-label="trimmed" />}
                    {(Math.max(0, plays) / 1000).toFixed(1)} s
                  </span>
                  {j && (j.in !== null || j.out !== null) && (
                    <span data-tip={`How much the picture jumps at each join, against the clip's own motion: ×1 moves like the clip, past ×${SHOWS} the join shows.`}>
                      · join{j.in !== null && <> in <span className={bad(j.in) ? "text-attention-ink" : "text-good"}>×{j.in}</span></>}{j.in !== null && j.out !== null && " ·"}{j.out !== null && <> out <span className={bad(j.out) ? "text-attention-ink" : "text-good"}>×{j.out}</span></>}
                    </span>
                  )}
                  {t.measure?.face != null && (
                    <span data-tip={`How much the face along the take is its person's: ArcFace against the cast's photo, else the first reference picture (a Motion transfer's Picture), else the picture the clip opens on (LTX, Wan), the median of a few frames${t.measure.faceLow != null ? `; the lowest ${t.measure.faceLow.toFixed(2)}` : ""}. Small or turned faces read lower: compare takes of one clip.`}>
                      · face {t.measure.face.toFixed(2)}
                    </span>
                  )}
                </span>
                {t.made && <MadeLine made={t.made} recipe={form?.recipes.find((r) => r.id === t.made!.recipe)} diff={takeDiff(t, form)} />}
              </span>
            </button>
            {on && onRetake && cutsAtJoin(t.measure) && <Button size="sm" className="mr-1 shrink-0" data-tip="Render a new take of this clip, carrying on from the same take of the clip before: the model makes it anew, and most takes carry on" onClick={onRetake}>New take</Button>}
            <IconButton size={28} label={`Take ${i + 1}: more`} tip="Face refine, Download, Keep, Compare, Remove…" aria-haspopup="menu" onClick={(e) => menu.open(e, t.asset)} className="mr-1 opacity-60 group-hover/take:opacity-100 focus-visible:opacity-100">
              <MoreHorizontal size={15} />
            </IconButton>
          </div>
        );
      })}
      {menu.element}
      {viewing && <Viewer asset={viewing} items={listed.map(({ t }) => t.asset)} onOpen={setViewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** How long a still is held; how long a take plays and how much is trimmed off its start, with Reset. */
export function Duration({ clip, take, room, rendered, onPatch }: { clip: Clip; take: Take | null; room: number; rendered: boolean; onPatch(patch: ShownPatch): void }) {
  // the pair while a knob moves, in seconds from the start of what can play
  const [moving, setMoving] = useState<{ from: number; to: number } | null>(null);
  if (clip.kind === "still") {
    return (
      <FieldRow label="Held for" trail>
        <NumberBox label="How long the still is held, in seconds" value={clip.lengthMs / 1000} min={0.5} max={60} step={0.1} unit="s" onCommit={(v) => onPatch({ stillMs: Math.round(v * 1000) })} />
      </FieldRow>
    );
  }
  if (!take) return null;
  // what can play counts from here: the take's start before its trim
  const base = take.startMs - take.trimStartMs;
  const from = take.trimStartMs / 1000;
  const to = (take.trimStartMs + clip.lengthMs) / 1000;
  const max = Math.max(to, (take.headMs + room - base) / 1000);
  const shown = moving ?? { from, to };
  // asked by what is seen: the server works out the trim, whatever a landing or a seamless join moves
  const commit = (f: number, t: number) => {
    setMoving(null);
    const trimStartMs = Math.round(f * 1000);
    const startMoved = trimStartMs !== take.trimStartMs;
    const endMoved = Math.abs(t - to) > 0.0005;
    if (startMoved || endMoved) onPatch({ ...(startMoved ? { trimStartMs } : {}), ...(endMoved ? { shownToMs: base + Math.round(t * 1000) } : {}) });
  };
  return (
    <FieldRow stack label="Plays" note={`Drag either end, or the clip's edges on the timeline. This trims what plays${rendered ? "; to make the clip itself longer, change Duration in Output and render a new take" : ""}.`}>
      <RangeSlider label="Plays" from={shown.from} to={shown.to} min={0} max={max} step={0.1} gap={0.3} format={(v) => `${v.toFixed(1)} s`} onChange={(f, t) => setMoving({ from: f, to: t })} onCommit={commit} />
      <span className="flex flex-wrap items-center justify-between gap-2 font-mono text-meta text-ink-2">
        <span>from {shown.from.toFixed(1)} s</span>
        {(take.trimStartMs > 0 || take.trimEndMs > 0) && <Button size="sm" className="font-sans" onClick={() => onPatch({ trimStartMs: 0, trimEndMs: 0 })}>Reset trim</Button>}
        <span>{(shown.to - shown.from).toFixed(1)} of {(room / 1000).toFixed(1)} s</span>
      </span>
    </FieldRow>
  );
}

/**
 * The pictures pinned on a clip's form: its first and last frame and a keyframe, each changed, dropped on or removed. A
 * right-click on one opens its menu: Mirror (flipped left to right at render time), and what its buttons do.
 */
export function PinnedFrames({ stored, pins, frames, midDefault, mirrors, pictures, onInputs, onPick, onMirror, onOpen }: {
  stored: Record<string, unknown>;
  pins: ReturnType<typeof pinInputs>;
  /** The pictures pinned now (its opening one only when it does not carry on from the clip before), whether it loops, whether it carries on. */
  frames: { opens: string | null; ends: string | null; through: string | null; loops: boolean; carries: boolean };
  midDefault: number;
  /** What each pinned frame's Mirror says (pinMirrors). */
  mirrors: PinMirror[];
  /** The pinned pictures as the server has them, for Open. */
  pictures: Clip["pictures"];
  onInputs(next: Record<string, unknown>): void;
  onPick(where: PinWhere): void;
  onMirror(input: string, on: boolean): void;
  /** The viewer, on a picture. */
  onOpen?(asset: Asset): void;
}) {
  const { opens, ends, through, loops, carries } = frames;
  const without = (id: string | undefined) => Object.fromEntries(Object.entries(stored).filter(([k]) => k !== id));
  const setPicking = onPick;
  const menu = useMenu<PinMirror>();
  const mirrorOf = (where: PinWhere) => mirrors.find((m) => m.where === where);
  /** The row's right-click: its frame's menu (none for a frame with nothing pinned). */
  const menuOn = (where: PinWhere) => (e: React.MouseEvent) => {
    const m = mirrorOf(where);
    if (m) menu.open(e, m);
  };
  const subject = menu.menu?.subject;
  const opened = subject ? pictures.find((p) => p.asset.id === subject.asset)?.asset : undefined;
  /** A pinned frame's thumbnail: flipped while mirrored, its ↔ mark on the corner. */
  const thumb = (where: PinWhere, id: string) => (
    <span className="relative shrink-0">
      <img src={thumbUrl(id)} alt="" className={cx("h-11 w-11 rounded-key object-cover", flipped(mirrorOf(where)?.on))} />
      {mirrorOf(where)?.on && <MirrorMark className="-top-1 -right-1" onMenu={menuOn(where)} />}
    </span>
  );
  return (
    <div className="flex flex-col gap-2">
            {[{ where: "start" as const, id: opens, input: pins.start, text: "First frame" }, { where: "end" as const, id: ends, input: pins.end, text: loops ? "Last frame, same as the first: it loops" : "Last frame" }].map((p) =>
              p.id ? (
                <PinDrop key={p.where} label={p.where === "start" ? "First frame" : "Last frame"} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [p.input!]: id })} onMenu={menuOn(p.where)}>
                  {thumb(p.where, p.id)}
                  <span className="grow">{p.text}</span>
                  <Button size="sm" onClick={() => setPicking(p.where)}>Change</Button>
                  <CloseButton size={28} label="Remove this pinned frame" onClose={() => onInputs(without(p.input))} />
                </PinDrop>
              ) : null,
            )}
            {through && pins.mid && pins.midAt && (
              <PinDrop label="Keyframe" className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })} onMenu={menuOn("mid")}>
                {thumb("mid", through)}
                <span className="grow">Keyframe at</span>
                <NumberBox label="When the clip reaches this keyframe, in seconds" value={Number(stored[pins.midAt] ?? midDefault)} min={0.5} max={14.5} step={0.5} unit="s" onCommit={(v) => onInputs({ ...stored, [pins.midAt!]: v })} />
                <CloseButton size={28} label="Remove this pinned frame" onClose={() => onInputs(without(pins.mid))} />
              </PinDrop>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* each takes a picture dropped on it: from the library, or a file from the computer */}
              {pins.start && !carries && !opens && <PinDrop label="First frame" className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.start!]: id })}><Button size="sm" onClick={() => setPicking("start")}><ImagePlus size={13} /> First frame</Button></PinDrop>}
              {pins.mid && !through && <PinDrop label="Keyframe" className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}><Button size="sm" onClick={() => setPicking("mid")}><ImagePlus size={13} /> Keyframe</Button></PinDrop>}
              {pins.end && !ends && <PinDrop label="Last frame" className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.end!]: id })}><Button size="sm" onClick={() => setPicking("end")}><ImagePlus size={13} /> Last frame</Button></PinDrop>}
            </div>
      {menu.menu && subject && (
        <ContextMenu
          at={menu.menu.at}
          label={`Actions on the ${PIN_WORDS[subject.where]}`}
          head={{ title: PIN_WORDS[subject.where].replace(/^./, (c) => c.toUpperCase()), sub: subject.on ? "mirrored at render time" : "pinned", thumb: subject.asset }}
          items={pinMenuItems(subject, {
            mirror: (on) => onMirror(subject.input, on),
            open: opened && onOpen ? () => onOpen(opened) : undefined,
            change: () => setPicking(subject.where),
            remove: () => onInputs(without(subject.input)),
          })}
          onClose={menu.close}
        />
      )}
    </div>
  );
}
