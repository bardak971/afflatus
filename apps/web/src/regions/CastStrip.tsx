import { useMemo } from "react";
import { User } from "lucide-react";
import { create } from "zustand";
import { sentPicture, thumbUrl, type Entity } from "../api";
import { useEntities } from "../data";
import { fileLabel } from "../format";
import { CloseButton } from "../ui";

/** A person of the Prompt kit dragged over the Stage (their id): onto a box, or onto the frame for a new one. */
export const DRAG_PERSON = "application/x-afflatus-person";

export type Person = Extract<Entity, { kind: "person" }>;

/**
 * The person being dragged from the strip, by id: a drop target cannot read what a drag carries until the drop, and the
 * Stage says over which box the person would land ("@Mira in region 2") while they are held over it.
 */
export const useDraggedPerson = create<{ id: string | null }>(() => ({ id: null }));

/** The Prompt kit's people, by name. */
export function usePeople(): Person[] {
  const entities = useEntities();
  return useMemo(() => (entities.data?.items ?? []).filter((e): e is Person => e.kind === "person").sort((a, b) => a.name.localeCompare(b.name)), [entities.data]);
}

/** What a person brings to a region on a family: their words, and their LoRA there at its weight (none: their words alone). */
export function personBrings(p: Person, family: string): { words: boolean; lora: { file: string; weight: number } | null } {
  const own = p.def.models[family];
  return { words: Boolean(p.def.tags.trim() || p.def.sentence.trim() || own?.trigger.trim()), lora: own?.lora ? { file: own.lora, weight: own.weight } : null };
}

/** A person's face, small and round, or their mark when they have no picture. */
export function PersonFace({ p, size = 24 }: { p: Person; size?: number }) {
  const face = sentPicture(p);
  return face
    ? <img src={thumbUrl(face)} alt="" draggable={false} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
    : <span className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-2" style={{ width: size, height: size }}><User size={size / 2} /></span>;
}

/**
 * The cast over the Stage's foot while regions are drawn (card #271): the Prompt kit's people, each dragged onto a box to
 * set who it is, or onto the frame for a new box where it lands. Their LoRA for the model in use said in their tip.
 */
export function CastStrip({ family, onClose }: { family: string; onClose(): void }) {
  const people = usePeople();
  return (
    <div role="group" aria-label="Cast" data-cast-strip className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl border border-line bg-panel px-3 py-1.5">
      <span className="shrink-0 text-meta font-bold tracking-label text-ink-3 uppercase">Cast</span>
      {/* the hint gives way first on a narrow Stage (cut with an ellipsis); the people wrap onto more lines rather than
          scroll sideways, so none is ever half shown */}
      <span data-tip="Drag a person onto a box to set who it is, or onto the frame for a new box where they land" className="min-w-0 shrink-[4] truncate text-xs text-ink-2">{people.length ? "drag onto a box, or onto the frame for a new box" : "No people in the Prompt kit yet"}</span>
      <div className="flex max-h-20 min-w-0 grow flex-wrap items-center justify-end gap-1.5 overflow-y-auto py-0.5">
        {people.map((p) => {
          const lora = personBrings(p, family).lora;
          return (
            <span
              key={p.id}
              role="button"
              tabIndex={-1}
              draggable
              data-person={p.id}
              aria-label={`${p.name}: drag onto a box or the frame`}
              data-tip={lora ? `${p.name} brings their words and ${fileLabel(lora.file)} · ${lora.weight.toFixed(2)}` : `${p.name} brings their words (no LoRA for this model)`}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_PERSON, p.id);
                e.dataTransfer.effectAllowed = "copy";
                useDraggedPerson.setState({ id: p.id });
              }}
              onDragEnd={() => useDraggedPerson.setState({ id: null })}
              className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 rounded-full border border-line-strong bg-raised pr-2.5 pl-1 text-xs font-semibold hover:bg-hover active:cursor-grabbing"
            >
              <PersonFace p={p} />
              {p.name}
            </span>
          );
        })}
      </div>
      <CloseButton size={28} label="Hide the cast" onClose={onClose} />
    </div>
  );
}
