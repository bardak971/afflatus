import { memo, useState } from "react";
import { Check, Download, Heart, Lock, Plus } from "lucide-react";
import type { BrowseCard } from "../api";
import { compact, plural, shortDate, size } from "../format";
import { Chip, cx, IconButton } from "../ui";

/**
 * A card's picture, faded in over a neutral block of its size when it comes (one that never comes leaves the block, the
 * card usable); for Hugging Face, which has none, a quiet panel with its owner's initial.
 */
function Thumb({ card }: { card: BrowseCard }) {
  const [shown, setShown] = useState(false);
  if (card.thumb) {
    return (
      <span className="block h-full w-full bg-raised">
        <img
          src={card.thumb}
          alt=""
          loading="lazy"
          draggable={false}
          // a picture the browser has already is complete before onLoad could say so
          ref={(img) => { if (img?.complete && img.naturalWidth) setShown(true); }}
          onLoad={() => setShown(true)}
          className={cx("h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none", shown ? "opacity-100" : "opacity-0")}
        />
      </span>
    );
  }
  return <span aria-hidden className="grid h-full w-full place-items-center bg-raised font-mono text-3xl text-ink-3">{card.creator.slice(0, 1).toUpperCase()}</span>;
}

/** A card still coming, in the card's shape: its picture's block, its name, two lines. */
export function CardSkeleton() {
  return (
    <div aria-hidden data-skeleton="" className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <span className="m-skeleton block h-[150px] w-full rounded-none!" />
      <span className="flex flex-col gap-2 px-3 py-3">
        <span className="m-skeleton block h-3.5 w-3/5" />
        <span className="m-skeleton block h-2.5 w-2/5" />
        <span className="m-skeleton block h-2.5 w-1/4" />
      </span>
    </div>
  );
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
      <button type="button" onClick={() => onOpen(card)} className="flex min-w-0 flex-col rounded-xl text-left focus-visible:outline-offset-[-2px]!">
        <span className="relative block h-[150px] w-full overflow-hidden">
          <Thumb card={card} />
          <span className="absolute top-2 left-2 rounded-md bg-shade/80 px-1.5 py-0.5 text-micro font-bold text-ink">{[card.type, card.fits ?? card.base].filter(Boolean).join(" · ")}</span>
          {picked && <Chip size="xs" tone="solid" className="absolute top-2 right-2"><Check size={11} /> picked</Chip>}
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
      <IconButton
        size={28}
        tone="primary"
        label={`Pick ${card.name}`}
        tip="Pick its file (a version of several files opens, to choose)"
        onClick={() => onQuick(card)}
        className="absolute top-[114px] right-2 opacity-0 shadow-lg group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Plus size={15} />
      </IconButton>
    </div>
  );
});
