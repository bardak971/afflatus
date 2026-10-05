import { useEffect, useRef, useState } from "react";
import { Camera, Clapperboard, Link2, Scissors, Star, Trash2 } from "lucide-react";
import type { Range } from "./Trim";
import { api, type Asset } from "./api";
import { useAsset } from "./data";
import { Kbd, plainKey } from "./Keys";
import { PngInfo } from "./PngInfo";
import { Button, cx } from "./ui";
import { ContextMenu, useMenu } from "./ContextMenu";
import { OPS } from "./viewer/shared";
import { useViewerActions } from "./viewer/useViewerActions";
import { ViewerMedia } from "./viewer/ViewerMedia";
import { ViewerSidebar } from "./viewer/ViewerSidebar";

/** One item, large, with how it was made and what can be done with it. */
export function Viewer({ asset: first, items, onOpen, onClose, inline, onDetails, into }: {
  asset: Asset;
  /** The list it was opened from: the arrow keys go to the item before and after. */
  items?: Asset[];
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
  // Trim: in and out on a video, and what is done with the range; the range's two frames are shown beside the video
  const [trim, setTrim] = useState(false);
  const [trimRange, setTrimRange] = useState<Range | null>(null);
  const asset = trail.at(-1) ?? first;
  /** The video's own right-click menu: what the buttons under it do. */
  const videoMenu = useMenu<true>();
  const imageMenu = useMenu<true>();
  const detail = useAsset(asset.id);
  // what a video gives besides itself: the frame it is paused on, and its sound; both open here once made
  const player = useRef<HTMLVideoElement>(null);
  const acts = useViewerActions({ asset, first, trailed: trail.length > 0, items, detail, into, inline, player, trim, setTrim, setInfo, onOpen, onClose, onOpened: (a) => setTrail((t) => [...t, a]) });
  const { a, g, recipe, keep, leave, again, queued, quick, toolFor, openTool, opener, openerName, animate, carrier, fromLastFrame, carryOn, saveFrame, move, toBin, download, videoItems, imageItems } = acts;

  const act = useRef<(e: KeyboardEvent) => void>(() => {});
  act.current = (e) => {
    // drawn in place, it leaves the keys to whatever is open over the screen
    if (inline && document.querySelector("[role=dialog][aria-modal=true]")) return;
    if (e.key === "Escape") {
      if (inline) return;
      if (!document.querySelector("[data-keys-help], [role=listbox], [role=menu]") && !info) onClose();
      return;
    }
    if (info || !plainKey(e, { over: "[data-keys-help]" })) return;
    const k = e.key.toLowerCase();
    // a video that has the focus keeps its own arrow keys
    const inPlayer = (e.target as HTMLElement | null)?.tagName === "VIDEO";
    if (e.key === "ArrowLeft" && !inPlayer) move(-1);
    else if (e.key === "ArrowRight" && !inPlayer) move(1);
    else if (a.inBin) return;
    else if (k === "s") keep.mutate(!a.kept);
    else if (e.key === "Delete") void toBin();
    else if (k === "d") download();
    else if (k === "l" && g && recipe) again.mutate(g);
    else if (k === "v" && g && recipe) queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" });
    else if (a.kind === "image" && (k === "u" || k === "f" || k === "b")) quick(k);
    else if (a.kind === "image" && (k === "i" || k === "e" || k === "r") && toolFor(k)) openTool.mutate(toolFor(k)!.id);
    else if (a.kind === "image" && k === "m" && opener) animate.mutate();
    else if (a.kind !== "audio" && k === "p" && !g) setInfo(true);
    else if (a.kind === "video" && k === "c" && carrier) carryOn.mutate();
    else if (a.kind === "video" && k === "g") saveFrame.mutate();
    else if (a.kind === "video" && k === "t" && !a.inBin) setTrim((t) => !t);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => act.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const menuElement = videoMenu.menu
    ? <ContextMenu at={videoMenu.menu.at} label="Actions on this video" items={videoItems()} onClose={videoMenu.close} />
    : imageMenu.menu
      ? <ContextMenu at={imageMenu.menu.at} label="Actions on this picture" items={imageItems()} onClose={imageMenu.close} />
      : null;
  const media = (overlay: boolean) => (
    <ViewerMedia
      acts={acts}
      player={player}
      trim={trim}
      onTrim={setTrim}
      trimRange={trimRange}
      onTrimRange={setTrimRange}
      onImageMenu={(e) => imageMenu.open(e, true)}
      onVideoMenu={(e) => videoMenu.open(e, true)}
      overlay={overlay}
      onDetails={onDetails}
      onClose={onClose}
    />
  );
  if (inline) {
    return (
      <div className="flex min-h-0 min-w-0 grow flex-col gap-2.5">
        {menuElement}
        {media(false)}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 pb-3">
          <Button size="sm" onClick={() => keep.mutate(!a.kept)} className={cx(a.kept && "border-accent text-accent")} title={a.kept ? "Kept" : "Not kept: it goes to the bin after a day"}>
            <Star size={13} fill={a.kept ? "currentColor" : "none"} /> {a.kept ? "Kept" : "Keep"} <Kbd>S</Kbd>
          </Button>
          {g && recipe && (
            <Button size="sm" disabled={queued.isPending} title="Same parameters, new seed: queued at once." onClick={() => queued.mutate({ recipe, stored: { ...g.inputs, seed: -1 }, label: "Variation" })}>Variation <Kbd>V</Kbd></Button>
          )}
          {a.kind === "image" && (["u", "f", "b"] as const).filter((k) => toolFor(k)).map((k) => (
            <Button key={k} size="sm" disabled={queued.isPending} title={`${OPS[k]!.label}: queued at once with the image's generation parameters.`} onClick={() => quick(k)}>{OPS[k]!.label} <Kbd>{k.toUpperCase()}</Kbd></Button>
          ))}
          {a.kind === "image" && (["i", "e", "r"] as const).filter((k) => toolFor(k)).map((k) => (
            <Button key={k} size="sm" disabled={openTool.isPending} title={`${OPS[k]!.label}: a new draft in the form, with this image as the source.`} onClick={() => openTool.mutate(toolFor(k)!.id)}>{OPS[k]!.label}… <Kbd>{k.toUpperCase()}</Kbd></Button>
          ))}
          {a.kind === "image" && opener && <Button size="sm" disabled={animate.isPending} title={`Image to video (i2v): a new video with this image as the first frame, on ${openerName} (the video model used last).`} onClick={() => animate.mutate()}><Clapperboard size={13} /> i2v <Kbd>M</Kbd></Button>}
          {a.kind === "video" && carrier && <Button size="sm" disabled={carryOn.isPending} title={fromLastFrame ? "Extend: a new clip whose first frame is the last frame of this one, same model and parameters." : "Extend: a new clip that carries on from the end of this one (previous clip)."} onClick={() => carryOn.mutate()}><Link2 size={13} /> Extend <Kbd>C</Kbd></Button>}
          {a.kind === "video" && <Button size="sm" disabled={saveFrame.isPending} title="Pause the video on the frame you want, then save it as an image." onClick={() => saveFrame.mutate()}><Camera size={13} /> Save frame <Kbd>G</Kbd></Button>}
          {a.kind === "video" && !a.inBin && <Button size="sm" className={cx(trim && "border-accent text-accent")} title="Trim: pick an in and an out, then copy, split or remove the range, save its frames, or generate between them." onClick={() => setTrim(!trim)}><Scissors size={13} /> Trim <Kbd>T</Kbd></Button>}
          {onDetails && <Button size="sm" onClick={onDetails} title="Generation parameters, folder, lineage and every action">Details</Button>}
          <Button size="sm" onClick={() => void toBin()} title="Move to the bin and go to the next one"><Trash2 size={13} /> Bin <Kbd>Del</Kbd></Button>
        </div>
      </div>
    );
  }

  return (
    <div data-stage role="dialog" aria-modal="true" aria-label="Item" className="fixed inset-0 z-40 flex bg-ground/95">
      {menuElement}
      {media(true)}
      <ViewerSidebar acts={acts} detail={detail} trail={trail} onTrail={setTrail} items={items} trim={trim} onTrim={setTrim} onInfo={setInfo} onClose={onClose} />
      {info && <PngInfo name={asset.name || "Untitled"} read={(recipe) => api.assetEmbedded(asset.id, recipe)} onClose={() => setInfo(false)} onSent={leave} />}
    </div>
  );
}
