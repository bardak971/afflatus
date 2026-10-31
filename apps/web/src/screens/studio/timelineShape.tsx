import { cx } from "../../ui";

/**
 * The timelines list's shape, a file of its own and light: the list (TimelineCards) is a chunk fetched when it is first
 * shown, and its placeholder cards stand in its place while that chunk comes, rather than a blank second (card #179).
 */

// M: four to a row beside the form, five without it; S and L one more and one fewer
export const CARD = { S: "minmax(250px,1fr)", M: "minmax(320px,1fr)", L: "minmax(440px,1fr)" } as const;
/** The narrowest a card gets, by size (CARD's), and the gap between cards: how many share a row. */
const CARD_MIN = { S: 250, M: 320, L: 440 } as const;
const CARD_GAP = 16;
/** The clips' shares of a placeholder card's strip: a strip of five clips of a few seconds, as most are. */
const PLACEHOLDER_STRIP = [1.2, 2, 2.2, 1.6, 2];

/**
 * How many cards make the first two rows, the New timeline card's place counted. Their strips are the first screen's
 * pictures: asked for at once and first, not queued lazily behind the rest of the page (the browser asks a server
 * for only a few at a time). The window's width is a little more than the grid's, so this errs on asking a card
 * or two more early, never fewer.
 */
export function firstScreenCards(size: "S" | "M" | "L"): number {
  const width = typeof window === "undefined" ? 1600 : window.innerWidth;
  return 2 * Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN[size] + CARD_GAP)));
}
/** How tall a card's film strip is, by the cards' size. */
export const STRIP_H = { S: "h-[72px]", M: "h-24", L: "h-32" } as const;

/**
 * A card while the list is on its way, laid out as a card is (TimelineCard): the strip's boxes, the name and when, the
 * facts line, each a placeholder with the loading shine at its line's height, so the real card lands in its place.
 */
export function PlaceholderCard({ size }: { size: "S" | "M" | "L" }) {
  return (
    <div aria-hidden className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <span className={cx("flex shrink-0 gap-0.5 px-2 pt-2", STRIP_H[size])}>
        {PLACEHOLDER_STRIP.map((grow, i) => <span key={i} style={{ flexGrow: grow }} className="m-skeleton min-w-4 basis-0 rounded-md!" />)}
      </span>
      <span className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="grow text-title font-bold"><span className="m-skeleton inline-block h-[0.8em] w-2/5 align-middle" /></span>
          <span className="shrink-0 text-xs"><span className="m-skeleton inline-block h-[0.8em] w-10 align-middle" /></span>
        </span>
        <span className="text-body"><span className="m-skeleton inline-block h-[0.8em] w-3/5 align-middle" /></span>
      </span>
    </div>
  );
}

/** The list's first two rows of placeholder cards, while its code comes. */
export function TimelineCardsWaiting({ size }: { size: "S" | "M" | "L" }) {
  return (
    <div aria-busy="true" className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD[size]})` }}>
      {Array.from({ length: firstScreenCards(size) }, (_, i) => <PlaceholderCard key={i} size={size} />)}
    </div>
  );
}
