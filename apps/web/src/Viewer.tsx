import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus, Star, Wand2 } from "lucide-react";
import type { Range } from "./Trim";
import { api, type Asset } from "./api";
import { useAsset } from "./data";
import { dialogOver } from "./Dialog";
import { Kbd, plainKey } from "./Keys";
import { Button, cx } from "./ui";
import { ContextMenu, useMenu, type MenuItem } from "./ContextMenu";
import { formPlaces, useFormTarget } from "./formTarget";
import { actionOfKey, keyOfEvent, keysShown, placeMenu, stageBar, toMenu, type ItemAction } from "./itemActions";
import { askViewer, takeViewerAsk } from "./viewer/ask";
import { useViewerActions, type ViewerMore } from "./viewer/useViewerActions";
import { assetHead } from "./TileMenu";
import { Compare } from "./viewer/Compare";
import { ViewerMedia } from "./viewer/ViewerMedia";
import { ViewerSidebar } from "./viewer/ViewerSidebar";

// the parameters reader is a chunk of its own: fetched the first time Details opens
const PngInfo = lazy(() => import("./PngInfo").then((m) => ({ default: m.PngInfo })));

/** One item, large, with how it was made and what can be done with it. */
export function Viewer({ asset: first, items, more, onOpen, onClose, inline, onDetails, into }: {
  asset: Asset;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
  /** The list has more pages: the arrow past the last item loaded reads the next one and carries on. */
  more?: ViewerMore;
  onOpen?(asset: Asset): void;
  onClose(): void;
  /** Drawn in place instead of over the screen: the item large, and under it what can be done with it. Its keys work the same. */
  inline?: boolean;
  /** In place: open it over the screen, with everything about it. */
  onDetails?(): void;
  /** What is queued from here belongs to this draft and lands in this folder. */
  into?: { draft?: string; folder?: string };
}) {
  // "made from" and "used to make" lead to other items without leaving the viewer
  const [trail, setTrail] = useState<Asset[]>([]);
  const [info, setInfo] = useState(false);
  // the name, edited in place at the top of the side (F2)
  const [naming, setNaming] = useState(false);
  // Trim: in and out on a video, and what is done with the range; the range's two frames are shown beside the video
  const [trim, setTrim] = useState(false);
  const [trimRange, setTrimRange] = useState<Range | null>(null);
  const asset = trail.at(-1) ?? first;
  // Compare: one item pinned, the arrow keys move the other one beside it
  const [pinned, setPinned] = useState<Asset | null>(null);
  /** The item's right-click menu (a picture, a video, a sound): its list, the open form first. */
  const itemMenu = useMenu<true>();
  /** The stage's bar: its Passes menu and its ··· menu. */
  const passesMenu = useMenu<true>();
  const moreMenu = useMenu<true>();
  const detail = useAsset(asset.id);
  // what a video gives besides itself: the frame it is paused on, and its sound; both open here once made
  const player = useRef<HTMLVideoElement>(null);
  const acts = useViewerActions({ asset, first, trailed: trail.length > 0, items, more, detail, into, inline, player, trim, onOpen, onClose, onOpened: (a) => setTrail((t) => [...t, a]) });
  const { a, g, leave, move, timeline } = acts;
  const formTarget = useFormTarget((st) => st.target);

  const canCompare = Boolean(items && items.length > 1 && onOpen && a.kind !== "audio");
  const toggleCompare = () => {
    if (pinned) return setPinned(null);
    setPinned(asset);
    if (!move(1)) move(-1);
  };
  const comparing = pinned !== null && pinned.id !== asset.id;
  /** Details (P): the parameters it was made with, unfolded in the side; for a file made elsewhere, those written in it (PNG info). */
  const details = () => {
    if (inline) {
      askViewer(a.id, "details");
      onDetails?.();
    } else if (!g) setInfo(true);
    else {
      const el = root.current?.querySelector<HTMLElement>("[data-viewer-params]");
      el?.querySelector("details")?.setAttribute("open", "");
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };
  const place = inline ? "inline" : "viewer";
  // the item's list, as every other place shows it: here Open is the item shown (in place: opened large), the name is
  // edited at the top of the side, Trim, Compare and Details are the viewer's own
  const list: ItemAction[] = acts.list(
    { shownHere: !inline || !onDetails, compare: canCompare ? true : "open it from a list", comparing, trimming: trim },
    {
      ...(inline && onDetails ? { open: onDetails } : {}),
      ...(inline ? {} : { rename: () => setNaming(true) }),
      trim: () => setTrim((t) => !t),
      ...(canCompare ? { compare: toggleCompare } : {}),
      details,
    },
  );

  // the item opened from a list outside (a tile's menu, the command bar) with a tool: it opens with it
  const [detailsAsked, setDetailsAsked] = useState(false);
  useEffect(() => {
    const what = takeViewerAsk(first.id);
    if (what === "trim" && first.kind === "video" && !first.inBin) setTrim(true);
    else if (what === "compare" && canCompare) toggleCompare();
    else if (what === "details") setDetailsAsked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.id]);
  // Details waits for the parameters to be read: whether it was made here decides what it shows
  useEffect(() => {
    if (!detailsAsked || detail.data?.id !== a.id) return;
    setDetailsAsked(false);
    details();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsAsked, detail.data?.id]);

  const act = useRef<(e: KeyboardEvent) => void>(() => {});
  // what the viewer draws: a modal that does not hold it is over it (drawn in place, any modal is)
  const root = useRef<HTMLDivElement>(null);
  act.current = (e) => {
    // a key already taken by another part of the screen is not taken twice
    if (e.defaultPrevented) return;
    // it leaves the keys to whatever is open over it (the keyboard shortcuts, a question asked)
    if (dialogOver(root.current)) return;
    // while trimming, L (loop) and Esc (close Trim) are Trim's own; this listener runs first
    if (trim && (e.key === "Escape" || e.key.toLowerCase() === "l")) return;
    if (e.key === "Escape") {
      if (pinned) {
        setPinned(null);
        return;
      }
      if (inline) return;
      if (!document.querySelector("[data-keys-help], [role=listbox], [role=menu]") && !info) onClose();
      return;
    }
    if (info || !plainKey(e, { over: "[data-keys-help]" })) return;
    const k = e.key.toLowerCase();
    // a video that has the focus keeps its own arrow keys
    const inPlayer = (e.target as HTMLElement | null)?.tagName === "VIDEO";
    // while trimming, the arrows step the frame (Trim.tsx), not to the next item
    if (e.key === "ArrowLeft" && !inPlayer && !trim) move(-1);
    else if (e.key === "ArrowRight" && !inPlayer && !trim) move(1);
    // drawn in place (the Studio's stage), N is the Studio's own (it folds the form): a timeline starts from the menus there
    else if (k === "n" && !inline && a.kind !== "audio" && !a.inBin) timeline.startFrom(a);
    else if (k === "a" && a.kind !== "audio" && !a.inBin && timeline.addToLast) timeline.addToLast(a);
    else {
      // every other key is the list's: the action whose key it is, when it acts here and is on now (in the bin, D)
      const action = actionOfKey(list, place, keyOfEvent(e));
      if (!action) return;
      action.run!();
    }
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => act.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const compare = comparing ? <Compare pinned={pinned!} other={asset} onSwap={() => { const was = pinned!; setPinned(asset); onOpen?.(was); }} onClose={() => setPinned(null)} /> : null;
  // the viewer's menu: the open form first (the place's own section), then the item's list
  const places = formPlaces(formTarget, a);
  const own: MenuItem[] = places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }] : [];
  const kindWord = a.kind === "audio" ? "sound" : a.kind === "image" ? "picture" : "video";
  const bar = stageBar(list);
  const menuElement = itemMenu.menu
    ? <ContextMenu at={itemMenu.menu.at} label={`Actions on this ${kindWord}`} head={assetHead(a)} items={placeMenu(own, list, place)} onClose={itemMenu.close} />
    : passesMenu.menu
      ? <ContextMenu at={passesMenu.menu.at} label="Passes" head={assetHead(a)} items={toMenu(bar.passes, place, false)} onClose={passesMenu.close} />
      : moreMenu.menu
        ? <ContextMenu at={moreMenu.menu.at} label={`More actions on this ${kindWord}`} head={assetHead(a)} items={placeMenu(own, bar.more, place)} onClose={moreMenu.close} />
        : null;
  const media = (overlay: boolean) => (
    <ViewerMedia
      acts={acts}
      player={player}
      trim={trim}
      onTrim={setTrim}
      trimRange={trimRange}
      onTrimRange={setTrimRange}
      onMenu={(e) => itemMenu.open(e, true)}
      overlay={overlay}
      onDetails={onDetails}
      onClose={onClose}
    />
  );
  if (inline) {
    /** One action of the bar: its label, its key where it acts, the reason in its tip when it is off. */
    const button = (x: ItemAction) => (
      <Button key={x.id} size="sm" tone={x.pressed && x.id !== "keep" ? "primary" : "plain"} aria-pressed={x.id === "keep" || x.id === "trim" || x.id === "compare" ? Boolean(x.pressed) : undefined} disabled={x.disabled} data-tip={x.disabled && x.note ? `${x.label}: ${x.note}` : x.tip} onClick={() => x.run?.()}>
        {x.id === "keep" ? <Star size={13} fill={x.pressed ? "currentColor" : "none"} /> : <x.icon size={13} />} {x.label} {x.key && keysShown(place, x.id) && <Kbd>{x.key}</Kbd>}
      </Button>
    );
    return (
      <div ref={root} className="flex min-h-0 min-w-0 grow flex-col gap-2.5">
        {menuElement}
        {timeline.element}
        {compare ?? media(false)}
        {/* one short row: the four most used, what makes something from it (Passes), the rest of the list (···), the bin */}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 pb-3">
          {bar.row.map(button)}
          {bar.passes.length > 0 && (
            <Button size="sm" aria-haspopup="menu" data-tip="Make from it, the passes and the tools, with their keys" onClick={(e) => passesMenu.open(e, true)} className={cx(passesMenu.menu && "border-accent")}>
              <Wand2 size={13} /> Passes ▾
            </Button>
          )}
          <Button size="sm" aria-haspopup="menu" aria-label="More actions" data-tip="Everything else that can be done with it" onClick={(e) => moreMenu.open(e, true)}><MoreHorizontal size={14} /></Button>
          {bar.bin && button(bar.bin)}
        </div>
      </div>
    );
  }

  return (
    <div ref={root} data-stage role="dialog" aria-modal="true" aria-label="Item" className="fixed inset-0 z-40 flex bg-stage/95">
      {menuElement}
      {timeline.element}
      {compare ?? media(true)}
      <ViewerSidebar acts={acts} list={list} asset={asset} detail={detail} naming={naming} onNaming={setNaming} trail={trail} onTrail={setTrail} items={items} onClose={onClose} />
      {info && <Suspense fallback={null}><PngInfo name={asset.name || "Untitled"} read={(recipe) => api.assetEmbedded(asset.id, recipe)} onClose={() => setInfo(false)} onSent={leave} /></Suspense>}
    </div>
  );
}
