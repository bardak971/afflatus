import { memo } from "react";
import { Check, Download, Heart, Lock, Plus } from "lucide-react";
import type { BrowseCard } from "../api";
import { compact, plural, shortDate, size } from "../format";
import { Chip, cx } from "../ui";

/** A card's picture, or for Hugging Face (which has none) a quiet panel with its owner's initial. */
function Thumb({ card }: { card: BrowseCard }) {
  if (card.thumb) return <img src={card.thumb} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />;
  return <span aria-hidden className="grid h-full w-full place-items-center bg-raised font-mono text-3xl text-ink-3">{card.creator.slice(0, 1).toUpperCase()}</span>;
}

/** What the card's first version weighs: its one file, or its files together. */
const weightOf = (card: BrowseCard) => {
  const files = card.versions[0]?.files ?? [];
  return files.length ? size(files.reduce((n, f) => n + f.bytes, 0)) : card.modelFiles ? plural(card.modelFiles, "file") : "";
};

/**
 * One model found: its picture, what it is and fits, what the user has of it, who made it and how used it is. Clicked, it
 * opens (its versions and files); its + picks its one file at once (a version of several opens instead); dragged onto
 * Picked, the same. The card's body and its + are two buttons side by side, not one inside the other: Enter on the + only
 * picks.
 */
export const Card = memo(function Card({ card, picked, onOpen, onQuick }: { card: BrowseCard; picked: boolean; onOpen(card: BrowseCard): void; onQuick(card: BrowseCard): void }) {
  const inSet = card.versions.flatMap((v) => v.files.flatMap((f) => f.have.filter((h) => h.kind === "set").map((h) => h.name)))[0];
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-afflatus-card", `${card.site}:${card.id}`);
        e.dataTransfer.effectAllowed = "copy";
      }}
      // drawn only near the view: a long list of found models (680 cards, 17 000 elements) lays out what is seen
      className={cx("group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-panel transition-colors [contain-intrinsic-size:auto_236px] [content-visibility:auto]", picked ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "border-line hover:border-line-strong")}
    >
      {/* the focus ring drawn inside: the card's rounded clip would cut one drawn outside */}
      <button type="button" onClick={() => onOpen(card)} className="flex min-w-0 flex-col rounded-xl text-left focus-visible:outline-offset-[-2px]">
        <span className="relative block h-[150px] w-full overflow-hidden">
          <Thumb card={card} />
          <span className="absolute top-2 left-2 rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-ink">{[card.type, card.fits ?? card.base].filter(Boolean).join(" · ")}</span>
          {picked && <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-micro font-bold text-accent-ink"><Check size={11} /> picked</span>}
          <span className="absolute bottom-2 left-2 flex flex-wrap gap-1">
            {card.have && <span className="rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-good">on this PC</span>}
            {inSet && <span className="rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-warn-ink">in set "{inSet}"</span>}
            {card.update && <span className="rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-accent">{card.update.latest} out · you have {card.update.have}</span>}
            {card.gated && <span className="flex items-center gap-1 rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-warn-ink"><Lock size={10} /> gated</span>}
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
          <span className="line-clamp-2 text-title font-semibold break-words" data-tip={card.name}>{card.name}</span>
          <span className="flex items-center gap-2 truncate text-xs text-ink-3">
            <span className="truncate">by {card.creator}</span>
            <span className="flex items-center gap-0.5"><Download size={11} />{compact(card.downloads)}</span>
            {card.likes > 0 && <span className="flex items-center gap-0.5"><Heart size={11} />{compact(card.likes)}</span>}
            {card.updatedAt && <span>· {shortDate(card.updatedAt)}</span>}
          </span>
          <span className="flex items-center gap-2 text-xs text-ink-2">
            {card.versions[0] && <span className="truncate">{card.versions[0].name}</span>}
            <span className="font-mono text-ink-3">{weightOf(card)}</span>
            {card.licence.credit && <Chip size="xs">credit the creator</Chip>}
            {card.licence.commercial === false && <Chip size="xs">no commercial use</Chip>}
          </span>
        </span>
      </button>
      {/* on the picture's bottom right corner (150 px high), over the body's button rather than in it */}
      <button
        type="button"
        aria-label={`Pick ${card.name}`}
        data-tip="Pick its file (a version of several files opens, to choose)"
        onClick={() => onQuick(card)}
        className="absolute top-[114px] right-2 grid size-7 place-items-center rounded-lg bg-accent text-accent-ink opacity-0 shadow-lg transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Plus size={15} />
      </button>
    </div>
  );
});
