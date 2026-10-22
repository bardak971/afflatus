import { Suspense, useRef } from "react";
import type { Asset } from "./api";
import { headLine, useMenu, type MenuHead, type MenuItem } from "./ContextMenu";
import { clock } from "./format";
import type { ActionId, Place } from "./itemActions";
import { lazyPart, loadTileMenuBody } from "./lazyParts";
import { tileName } from "./screens/library/tileName";

// the menu's list and what its lines do are a chunk of their own (lazyParts.ts), fetched once the page is idle: every
// tile of the library has this hook, and none of it is needed to draw the grid
const Body = lazyPart(loadTileMenuBody, (m) => m.TileMenuBody);

/** What the place a tile's menu opens in says about it (see useTileMenu). */
export interface TileMenuOptions {
  onOpen(asset: Asset): void;
  /** Where the menu opens: which keys act there. */
  place?: Place;
  /** "Use in this draft" when a form is open: not where the open form is not the Studio's (the timeline's media shelf). */
  form?: boolean;
  /** The viewer opens on the place's list (the arrows step through it, Compare works); not where it opens on the item alone. */
  listed?: boolean;
  /** The seed, when the place knows it before the item's parameters are read (a finished job of the queue). */
  seed?: number | null;
  /** What the place the menu opens in does with the item, before everything else (the editor's library: add it to the timeline). */
  first?(asset: Asset): MenuItem[];
  /** Tick it, for a move / keep / bin of several. */
  onSelect?(asset: Asset): void;
  /** Where a variation queued from here lands. */
  into?: { draft?: string; folder?: string };
  /** Actions the place does its own way in its first section, left out of the list (a take's Remove takes its file to the bin with it). */
  omit?: readonly ActionId[];
}

/**
 * The right-click menu of a library tile: the item's list (itemActions.tsx), the same as the viewer's, after what the
 * place does with the item (`first`, the open form's "Use in this draft", Select). Its keys show only where they act
 * (`place`). What needs the item's generation parameters (Reuse, Variation, the seed, ComfyUI) is offered once they
 * are read, which starts when the menu opens; until then those lines say "reading…". Trim, Compare and Details open
 * the viewer on the item with that tool. The list itself is TileMenuBody.tsx.
 */
export function useTileMenu(options: TileMenuOptions) {
  const { menu, open, close } = useMenu<Asset>();
  // the item last shown stays the actions' subject once the menu closes: a choice closes the menu first, and the
  // hooks that do it (Mirror, Inpaint, Edit, Outpaint, Image to video…) read their item when their request starts, a
  // moment later (the command bar keeps its last render for the same reason)
  const last = useRef<Asset | null>(null);
  if (menu) last.current = menu.subject;
  const acting = last.current;
  // nothing is drawn, nor read, before the first opening
  const element = acting && (
    <Suspense fallback={null}>
      <Body {...options} menu={menu} acting={acting} onClose={close} />
    </Suspense>
  );
  return { open, element };
}

const KIND_WORD = { image: "Picture", video: "Video", audio: "Sound" } as const;

/** The head of an item's menu: its picture, its name, "Picture · 1216×832", "Video · 0:08 · 576×1024 · Clip 3", "Sound · 2:47". */
export function assetHead(a: Asset): MenuHead {
  const length = a.kind !== "image" && a.durationMs !== null ? <span className="font-mono">{clock(a.durationMs)}</span> : null;
  // a sound has no frame to measure
  const size = a.kind !== "audio" && a.width && a.height ? <span className="font-mono">{a.width}×{a.height}</span> : null;
  return {
    title: tileName(a),
    // a sound has no picture
    thumb: a.kind === "audio" ? undefined : a.id,
    sub: headLine(KIND_WORD[a.kind], length, size, a.clipOf && `Clip ${a.clipOf.clip}`),
  };
}
