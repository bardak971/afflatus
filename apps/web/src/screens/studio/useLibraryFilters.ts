import { useEffect, useMemo, useState } from "react";
import { useAssets } from "../../data";
import { useSettled } from "../../hooks";
import type { Place } from "../Library";
import type { Scope } from "../../store";
import { useExpiringOnly } from "./expiring";

/** The scopes there are now. */
const SCOPES: readonly Scope[] = ["draft", "all", "recent"];

export const KINDS = [
  { id: "all", label: "All", kind: undefined },
  { id: "image", label: "Images", kind: "image" },
  { id: "video", label: "Videos", kind: "video" },
  { id: "audio", label: "Audio", kind: "audio" },
  { id: "timeline", label: "Timelines", kind: undefined },
] as const;
export type LibraryKind = (typeof KINDS)[number]["id"];

/** What the library's grid is narrowed to: the kind, the search, the model and LoRA it was made with, Kept only (or Expiring only); and the items that match. */
export function useLibraryFilters({ place, view, draftId, initialKind = "all", onKind }: {
  place: Place;
  /** What the grid opens on: the Timelines entry of the rail opens it on the timelines. */
  initialKind?: LibraryKind;
  /** Told when the kind is changed from the chips (the Studio moves between / and /timelines with it). */
  onKind?(kind: LibraryKind): void;
  /** The form open or not, and what the grid shows beside it. */
  view: { form: boolean; scope: Scope };
  draftId: string | null;
}) {
  const [kind, setKindState] = useState<LibraryKind>(initialKind);
  const setKind = (k: LibraryKind) => {
    setKindState(k);
    onKind?.(k);
  };
  const [typed, setTyped] = useState("");
  // what is typed is looked for once the typing stops
  const q = useSettled(typed);
  // made with: a model family ("f:sdxl"), or one model file ("m:<file>"); and with one LoRA
  const [made, setMade] = useState("");
  const [lora, setLora] = useState("");
  const family = made.startsWith("f:") ? made.slice(2) : "";
  const model = made.startsWith("m:") ? made.slice(2) : "";
  // Kept only, or the other way round: only what expires (Filters, or "Show them" from the status bar's expiring
  // chip, which is why that one is held outside the screen)
  const [kept, setKeptState] = useState(false);
  const unkept = useExpiringOnly((s) => s.on);
  const setUnkeptState = useExpiringOnly((s) => s.set);
  const setKept = (on: boolean) => {
    setKeptState(on);
    if (on) setUnkeptState(false);
  };
  const setUnkept = (on: boolean) => {
    setUnkeptState(on);
    if (on) setKeptState(false);
  };
  // turned on from the status bar while Kept only was on: the two cannot both hold
  useEffect(() => {
    if (unkept) setKeptState(false);
  }, [unkept]);
  const showTimelines = kind === "timeline" && place.type !== "bin";
  // with the form open, "Recent" and "Kept" look across the project, not the folder: what is there to drag into the form
  // "Kept" was a scope: a store kept from then still says it, and shows the folder (Kept only is in Filters now)
  const reach: Scope = view.form && draftId && SCOPES.includes(view.scope) ? view.scope : "all";
  const since48 = useMemo(() => new Date(Date.now() - 2 * 86_400_000).toISOString(), [reach]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter = {
    kind: KINDS.find((k) => k.id === kind)!.kind,
    bin: place.type === "bin" || undefined,
    // "This draft": what the draft made, wherever it landed
    draft: reach === "draft" && draftId ? draftId : undefined,
    folder: reach === "recent" || reach === "draft" ? undefined : place.type === "folder" ? place.id : place.type === "unfiled" ? "none" : undefined,
    since: reach === "recent" ? since48 : undefined,
    q: q || undefined,
    family: family || undefined,
    model: model || undefined,
    lora: lora || undefined,
    // nothing in the bin counts down to it: Kept only and Expiring only are left aside there, not cleared
    kept: (place.type !== "bin" && kept) || undefined,
    unkept: (place.type !== "bin" && unkept) || undefined,
  };
  const assets = useAssets(filter, true, true);
  const items = showTimelines ? [] : assets.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(q || made || lora || filter.kept || filter.unkept);
  return { kind, setKind, typed, setTyped, q, made, setMade, lora, setLora, kept, setKept, unkept, setUnkept, showTimelines, reach, filter, assets, items, filtered };
}

export type LibraryFilters = ReturnType<typeof useLibraryFilters>;
