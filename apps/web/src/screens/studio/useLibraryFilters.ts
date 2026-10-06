import { useMemo, useState } from "react";
import { useAssets } from "../../data";
import { useSettled } from "../../hooks";
import type { Place } from "../Library";

export const KINDS = [
  { id: "all", label: "All", kind: undefined },
  { id: "image", label: "Images", kind: "image" },
  { id: "video", label: "Videos", kind: "video" },
  { id: "audio", label: "Audio", kind: "audio" },
  { id: "timeline", label: "Timelines", kind: undefined },
] as const;
export type LibraryKind = (typeof KINDS)[number]["id"];

/** What the library's grid is narrowed to: the kind, the search, the model and LoRA it was made with, Kept only; and the items that match. */
export function useLibraryFilters({ place, view, draftId, initialKind = "all", onKind }: {
  place: Place;
  /** What the grid opens on: the Timelines entry of the rail opens it on the timelines. */
  initialKind?: LibraryKind;
  /** Told when the kind is changed from the chips (the Studio moves between / and /timelines with it). */
  onKind?(kind: LibraryKind): void;
  /** The form open or not, and what the grid shows beside it. */
  view: { form: boolean; scope: "draft" | "all" | "recent" | "kept" };
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
  const [kept, setKept] = useState(false);
  const showTimelines = kind === "timeline" && place.type !== "bin";
  // with the form open, "Recent" and "Kept" look across the project, not the folder: what is there to drag into the form
  // "Kept" was a scope: one left on it shows the folder (Kept only is in Filters now)
  const reach = view.form && draftId && view.scope !== "kept" ? view.scope : "all";
  const since48 = useMemo(() => new Date(Date.now() - 2 * 86_400_000).toISOString(), [reach]); // eslint-disable-line react-hooks/exhaustive-deps
  const assets = useAssets({
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
    kept: kept || undefined,
  });
  const items = showTimelines ? [] : assets.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(q || made || lora || kept);
  return { kind, setKind, typed, setTyped, q, made, setMade, lora, setLora, kept, setKept, showTimelines, reach, assets, items, filtered };
}

export type LibraryFilters = ReturnType<typeof useLibraryFilters>;
