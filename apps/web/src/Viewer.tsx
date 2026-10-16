import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, Plus, Star, Wand2 } from "lucide-react";
import type { Range } from "./Trim";
import { api, type Asset } from "./api";
import { useAsset } from "./data";
import { dialogOver } from "./Dialog";
import { Kbd, plainKey } from "./Keys";
import { useLeave } from "./leave";
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
import { useCompareResult } from "./store";

// the parameters reader is a chunk of its own: fetched the first time Details opens
const PngInfo = lazy(() => import("./PngInfo").then((m) => ({ default: m.PngInfo })));

/** A file that came from outside (uploaded, a linked folder's, imported): what made it may be written in it. An extracted sound is made here. */
const madeElsewhere = (a: Asset) => a.origin === "uploaded" || (a.origin === "imported" && a.kind !== "audio");

/** One item, large, with how it was made and what can be done with it. */
export function Viewer({ asset: first, items, more, onOpen, onClose, inline, onDetails, onEscape, into }: {
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
  /** In place, Esc with nothing else to close: what the place does with it (the stage goes back to the render under way). */
  onEscape?(): void;
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
  // comparing: Wipe and Swap, by their keys (W, Shift+X), filled by Compare
  const compareKeys = useRef<{ wipe(): void; swap(): void } | null>(null);
  const acts = useViewerActions({ asset, first, trailed: trail.length > 0, items, more, detail, into, inline, player, trim, onOpen, onClose, onOpened: (a) => setTrail((t) => [...t, a]) });
  const { a, g, leave, move, timeline } = acts;
  const formTarget = useFormTarget((st) => st.target);

  const compareResult = useCompareResult((s) => s.on);
  const known = detail.data?.id === asset.id ? detail.data : null;
  /**
   * What Compare puts side by side when it opens on original vs result (the setting): on a pass's result, its source
   * (pinned) and itself; on a picture something was made from, itself (pinned) and the newest of those. Only the same
   * kind of thing: an i2v video is no result to wipe against its picture.
   */
  const pair = (() => {
    if (!compareResult || !known) return null;
    const source = known.sources.find((s) => s.role === "source" && s.asset.kind === asset.kind && !s.asset.inBin)?.asset;
    if (source) return { pin: source, show: null };
    const newest = known.usedIn.filter((x) => x.kind === asset.kind && !x.inBin).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return newest ? { pin: asset, show: newest } : null;
  })();
  // with a result to compare against, Compare works even opened alone (a toast's Compare)
  const canCompare = a.kind !== "audio" && (Boolean(items && items.length > 1 && onOpen) || Boolean(pair));
  const toggleCompare = () => {
    if (pinned) return setPinned(null);
    if (pair) {
      setPinned(pair.pin);
      if (pair.show) setTrail((t) => [...t, pair.show!]);
      return;
    }
    setPinned(asset);
    if (!move(1)) move(-1);
  };
  const comparing = pinned !== null && pinned.id !== asset.id;
  /** Details (P): the parameters it was made with, unfolded in the side; for a file made elsewhere, those written in it (PNG info). */
  const details = () => {
    if (inline) {
      askViewer(a.id, "details");
      onDetails?.();
    } else if (!g && madeElsewhere(a)) setInfo(true);
    else if (!g) {
      // made here from another item (a cut, a frame, an export, a mirrored copy): no parameters of its own, nothing written
      // in its file; what it was made from and its facts are in the side
      const el = root.current?.querySelector<HTMLElement>("[data-viewer-file]");
      el?.setAttribute("open", "");
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    } else {
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
  const [compareAsked, setCompareAsked] = useState(false);
  useEffect(() => {
    const what = takeViewerAsk(first.id);
    if (what === "trim" && (first.kind === "video" || first.kind === "audio") && !first.inBin) setTrim(true);
    else if (what === "compare") setCompareAsked(true);
    else if (what === "details") setDetailsAsked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per item: the ask is taken, not watched
  }, [first.id]);
  // Compare asked from outside waits for the item's details too: whether there is a result to put beside it is in them
  useEffect(() => {
    if (!compareAsked || detail.data?.id !== a.id) return;
    setCompareAsked(false);
    if (canCompare && !pinned) toggleCompare();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the details come: the rest is read as it stands then
  }, [compareAsked, detail.data?.id]);
  // Details waits for the parameters to be read: whether it was made here decides what it shows
  useEffect(() => {
    if (!detailsAsked || detail.data?.id !== a.id) return;
    setDetailsAsked(false);
    details();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the details come: details is new at every render
  }, [detailsAsked, detail.data?.id]);

  const act = useRef<(e: KeyboardEvent) => void>(() => {});
  // what the viewer draws: a modal that does not hold it is over it (drawn in place, any modal is)
  const root = useRef<HTMLDivElement>(null);
  // over the screen, it comes in as a panel and fades as a still copy when closed (its keys and focus go at once); going
  // from item to item with ← → keeps the same element, so only opening and closing move
  const overlayRef = useLeave("m-out", root);
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
      const open = document.querySelector("[data-keys-help], [role=listbox], [role=menu]") || info;
      if (inline) {
        if (!open) onEscape?.();
        return;
      }
      if (!open) onClose();
      return;
    }
    if (info || !plainKey(e, { over: "[data-keys-help]" })) return;
    // Enter on a button, a link or a row that has the focus is theirs (it presses them), not Open's
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.closest?.("button, a, [role=button], [role=option], [role=slider], [role=menuitem], summary")) return;
    const k = e.key.toLowerCase();
    // a video that has the focus keeps its own arrow keys
    const inPlayer = (e.target as HTMLElement | null)?.tagName === "VIDEO";
    // while trimming, the arrows step the frame (Trim.tsx), not to the next item
    if (e.key === "ArrowLeft" && !inPlayer && !trim) move(-1);
    else if (e.key === "ArrowRight" && !inPlayer && !trim) move(1);
    // drawn in place (the Studio's stage), N is the Studio's own (it folds the form): a timeline starts from the menus there
    else if (k === "n" && !inline && a.kind !== "audio" && !a.inBin) timeline.startFrom(a);
    else if (k === "a" && a.kind !== "audio" && !a.inBin && timeline.addToLast) timeline.addToLast(a);
    // comparing: W lays the two pictures over each other (or side by side again), Shift+X swaps the pinned one and the other
    else if (comparing && k === "w" && !e.shiftKey && compareKeys.current) compareKeys.current.wipe();
    else if (comparing && k === "x" && e.shiftKey && compareKeys.current) compareKeys.current.swap();
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

  const compare = comparing ? <Compare pinned={pinned!} other={asset} onSwap={() => { const was = pinned!; setPinned(asset); onOpen?.(was); }} onClose={() => setPinned(null)} keys={compareKeys} /> : null;
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
      <Button key={x.id} size="sm" tone={x.pressed && x.id !== "keep" ? "primary" : "plain"} aria-pressed={x.id === "keep" || x.id === "trim" || x.id === "compare" ? Boolean(x.pressed) : undefined} disabled={x.disabled} data-tip={x.disabled && x.note ? `${x.label}: ${x.note}` : x.tip} onClick={() => x.run?.()} className={cx(x.done && "m-ok border-good/50! bg-good/15 text-good!")}>
        {x.id === "keep" ? <Star size={13} fill={x.pressed ? "currentColor" : "none"} /> : x.done ? <Check size={13} /> : <x.icon size={13} />} {x.label} {x.key && keysShown(place, x.id) && <Kbd>{x.key}</Kbd>}
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
    <div ref={overlayRef} data-stage role="dialog" aria-modal="true" aria-label="Item" className="m-panel fixed inset-0 z-40 flex bg-stage/95">
      {menuElement}
      {timeline.element}
      {compare ?? media(true)}
      <ViewerSidebar acts={acts} list={list} asset={asset} detail={detail} naming={naming} onNaming={setNaming} trail={trail} onTrail={setTrail} items={items} onClose={onClose} />
      {info && <Suspense fallback={null}><PngInfo name={asset.name || "Untitled"} title={asset.kind === "image" ? "PNG info" : "Embedded info"} read={(recipe) => api.assetEmbedded(asset.id, recipe)} onClose={() => setInfo(false)} onSent={leave} /></Suspense>}
    </div>
  );
}
