import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ImagePlus, Scissors, X } from "lucide-react";
import { api, thumbUrl, type Asset, type Clip, type Take } from "../../api";
import { Button, cx, NumberBox } from "../../ui";
import { FieldRow } from "../../fields";
import { RangeSlider } from "../../RangeSlider";
import { DRAG_PICTURE, useDropZone } from "../../dragging";
import { projectForNew } from "../../project";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { PIN_WORDS, pinInputs, takeTrouble, type PinMirror, type PinWhere, type ShownPatch } from "../model";
import { pinMenuItems } from "../menus";
import { flipped, MirrorMark } from "../MirrorMark";
import { SHOWS } from "../attention";
import { useRecipes } from "../../data";

/** A place a picture can be dropped on to become a pinned frame: one from the library, or a file from the computer, which goes into the library first. */
function PinDrop({ className, onPick, onMenu, children }: { className?: string; onPick(id: string): void; onMenu?(e: React.MouseEvent): void; children: ReactNode }) {
  const upload = useMutation({ mutationFn: (file: File) => api.upload(file, { project: projectForNew() }), onSuccess: (a) => onPick(a.id) });
  const drop = useDropZone([DRAG_PICTURE], onPick, (file) => file.type.startsWith("image/") && upload.mutate(file));
  return (
    <div {...drop.props} onContextMenu={onMenu} className={cx(className, drop.zone, drop.wanted && "ring-1 ring-accent/50")} data-tip={drop.wanted ? "Drop the picture here" : undefined}>
      {children}
      {upload.isPending && <span className="ml-1 text-xs text-ink-2">Adding…</span>}
    </div>
  );
}

/** A state of a take, on its row: plays (filled), finished, smoothest. */
function TakeChip({ tone, tip, children }: { tone: "accent" | "good" | "warn" | "neutral"; tip?: string; children: ReactNode }) {
  return (
    <span data-tip={tip} className={cx("flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[11px] font-bold", tone === "accent" ? "bg-accent text-accent-ink" : tone === "good" ? "bg-good/15 text-good" : tone === "warn" ? "bg-warn/15 text-warn-ink" : "bg-hover text-ink-2")}>
      {children}
    </span>
  );
}

/** A clip's takes, one per row, the one that plays marked: hovered, one is previewed in the player; clicked, it plays. Each says how its joins jump, and can be removed. */
export function TakeList({ clip, take, joinOf, smoothest, onPreview, onPatch, onRemoveTake }: {
  clip: Clip;
  take: Take | null;
  joinOf(take: string): { in: number | null; out: number | null } | undefined;
  /** The take whose joins jump least, once measured. */
  smoothest: string | null;
  onPreview(take: Take | null): void;
  onPatch(patch: ShownPatch): void;
  onRemoveTake(id: string): void;
}) {
  // past ×3 the join shows, as Needs attention counts it
  const bad = (v: number) => v > SHOWS;
  // how much each take's face is its person's (Face Match, measured after the render): the closest marked when two or more
  // were measured, to pick from, never rendered again by itself (the owner: no automatic retries; card #18)
  const faced = clip.takes.filter((t) => t.measure?.face != null);
  const closest = faced.length > 1 ? faced.reduce((best, t) => (t.measure!.face! > best.measure!.face! ? t : best)).id : null;
  // takes made with more than one form (a source's form changed in place, its takes kept): each says its own
  const recipes = useRecipes();
  const forms = new Set(clip.takes.map((t) => t.recipe).filter(Boolean));
  const formOf = (t: Take) => (forms.size > 1 && t.recipe ? recipes.data?.recipes.find((r) => r.id === t.recipe)?.title ?? null : null);
  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
      {clip.takes.map((t, i) => {
        const on = t.id === take?.id;
        const j = joinOf(t.id);
        const trouble = takeTrouble(t, clip.takes);
        const plays = t.endMs - t.startMs;
        const file = t.asset.durationMs ?? 0;
        // the thumbnail at the take's own shape, 54 px on its long side
        const w = t.asset.width ?? 0;
        const h = t.asset.height ?? 0;
        const thumb = w && h ? (h >= w ? { width: Math.max(24, Math.round((54 * w) / h)), height: 54 } : { width: 54, height: Math.max(24, Math.round((54 * h) / w)) }) : { width: 34, height: 54 };
        return (
          <div
            key={t.id}
            className={cx("group/take flex items-center rounded-[10px]", on ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : "hover:bg-hover")}
            onMouseEnter={() => !on && onPreview(t)}
            onMouseLeave={() => onPreview(null)}
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
              <span className="flex min-w-0 grow flex-col gap-[3px]">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-bold">Take {i + 1}</span>
                  {on && <TakeChip tone="accent">plays</TakeChip>}
                  {trouble && <TakeChip tone="warn" tip={trouble}>broken</TakeChip>}
                  {t.finishedFrom && !trouble && <TakeChip tone="good" tip={`The finished version of take ${Math.max(1, clip.takes.findIndex((x) => x.id === t.finishedFrom) + 1)}: the same clip, brought to its final quality (${t.asset.width} × ${t.asset.height})`}>finished</TakeChip>}
                  {smoothest === t.id && clip.takes.length > 1 && <TakeChip tone="neutral" tip="The smoothest joins of the takes">smoothest</TakeChip>}
                  {closest === t.id && <TakeChip tone="neutral" tip="The face closest to its person's picture, of the takes measured">closest face</TakeChip>}
                  {formOf(t) && <TakeChip tone="neutral" tip="The form it was rendered with: this clip's takes come from more than one">{formOf(t)}</TakeChip>}
                </span>
                {t.measure?.face != null && (
                  <span className="font-mono text-[11px] text-ink-3" data-tip={`How much the face along the take is its person's: ArcFace against the cast's photo, else the first reference picture (a Motion transfer's Picture), the median of a few frames${t.measure.faceLow != null ? `; the lowest ${t.measure.faceLow.toFixed(2)}` : ""}. Small or turned faces read lower: compare takes of one clip.`}>
                    face {t.measure.face.toFixed(2)}
                  </span>
                )}
                {j && (j.in !== null || j.out !== null) && (
                  <span className="font-mono text-[11px] text-ink-3" data-tip={`How much the picture jumps at each join, against the clip's own motion: ×1 moves like the clip, past ×${SHOWS} the join shows.`}>
                    join{j.in !== null && <> in <span className={bad(j.in) ? "text-warn-ink" : "text-good"}>×{j.in}</span></>}{j.in !== null && j.out !== null && " ·"}{j.out !== null && <> out <span className={bad(j.out) ? "text-warn-ink" : "text-good"}>×{j.out}</span></>}
                  </span>
                )}
              </span>
              {/* how long it plays; a trimmed take says so, its file being longer than what plays */}
              <span className={cx("flex shrink-0 items-center gap-1 font-mono text-[11.5px]", trouble ? "text-warn-ink" : "text-ink-2")} data-tip={!trouble && (t.trimStartMs > 0 || t.trimEndMs > 0) && file > plays ? `Trimmed: plays ${(plays / 1000).toFixed(1)} of its ${(file / 1000).toFixed(1)} s` : undefined}>
                {!trouble && (t.trimStartMs > 0 || t.trimEndMs > 0) && <Scissors size={11} aria-label="trimmed" className="text-ink-3" />}
                {(Math.max(0, plays) / 1000).toFixed(1)} s
              </span>
            </button>
            <button type="button" aria-label={`Remove take ${i + 1}`} data-tip="Remove this take. Its video goes to the bin with it; Undo brings both back." onClick={() => onRemoveTake(t.id)} className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-hover/take:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100">
              <X size={13} />
            </button>
          </div>
        );
      })}
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
      <span className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11.5px] text-ink-2">
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
      <img src={thumbUrl(id)} alt="" className={cx("h-11 w-11 rounded-[3px] object-cover", flipped(mirrorOf(where)?.on))} />
      {mirrorOf(where)?.on && <MirrorMark className="-top-1 -right-1" onMenu={menuOn(where)} />}
    </span>
  );
  return (
    <div className="flex flex-col gap-2">
            {[{ where: "start" as const, id: opens, input: pins.start, text: "First frame" }, { where: "end" as const, id: ends, input: pins.end, text: loops ? "Last frame, same as the first: it loops" : "Last frame" }].map((p) =>
              p.id ? (
                <PinDrop key={p.where} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [p.input!]: id })} onMenu={menuOn(p.where)}>
                  {thumb(p.where, p.id)}
                  <span className="grow">{p.text}</span>
                  <Button size="sm" onClick={() => setPicking(p.where)}>Change</Button>
                  <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(p.input))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
                </PinDrop>
              ) : null,
            )}
            {through && pins.mid && pins.midAt && (
              <PinDrop className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })} onMenu={menuOn("mid")}>
                {thumb("mid", through)}
                <span className="grow">Keyframe at</span>
                <NumberBox label="When the clip reaches this keyframe, in seconds" value={Number(stored[pins.midAt] ?? midDefault)} min={0.5} max={14.5} step={0.5} unit="s" onCommit={(v) => onInputs({ ...stored, [pins.midAt!]: v })} />
                <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(pins.mid))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
              </PinDrop>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* each takes a picture dropped on it: from the library, or a file from the computer */}
              {pins.start && !carries && !opens && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.start!]: id })}><Button size="sm" onClick={() => setPicking("start")}><ImagePlus size={13} /> First frame</Button></PinDrop>}
              {pins.mid && !through && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}><Button size="sm" onClick={() => setPicking("mid")}><ImagePlus size={13} /> Keyframe</Button></PinDrop>}
              {pins.end && !ends && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.end!]: id })}><Button size="sm" onClick={() => setPicking("end")}><ImagePlus size={13} /> Last frame</Button></PinDrop>}
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
