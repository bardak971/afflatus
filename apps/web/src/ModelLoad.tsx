import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { create } from "zustand";
import { api, type RecipeInfo } from "./api";
import { useQueue } from "./data";
import { cx } from "./ui";
import { queryKeys } from "./queryKeys";

/** The same keys holding the same values (a value that is an object counts by itself, not by what it holds). */
const sameEntries = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
};

/** Stops a render that is under way, or takes one that waits out of the queue. Nothing is added. */
export function useStop() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.cancel(id);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
  });
}

type Look = Parameters<typeof api.warm>[2];
interface OpenForm {
  recipe: RecipeInfo;
  input: Record<string, unknown>;
  look: Look;
}
/**
 * What the form on screen tells the strip at the bottom of every screen: the form itself (its models
 * are said to be loaded or not there, with the button that loads them), and where its results go.
 * Kept out of the form so that the form ends on its Make button alone.
 */
const useStrip = create<{ form: OpenForm | null; place: { name: string; path: string | null } | "unfiled" | null }>(() => ({ form: null, place: null }));

/** Put in a form: the strip speaks for it while it is on screen. */
export function FormModel({ recipe, input, look }: OpenForm) {
  // told again only when something in the form changed: compared value by value, and written out whole only
  // when a value is a new object (a form whose values are made afresh at each draw)
  const said = useRef<OpenForm | null>(null);
  useEffect(() => {
    const was = said.current;
    if (was && was.recipe === recipe && was.look === look && (sameEntries(was.input, input) || JSON.stringify(was.input) === JSON.stringify(input))) return;
    said.current = { recipe, input, look };
    useStrip.setState({ form: said.current });
  });
  // gone: the strip forgets the form, unless another one has spoken for itself since (a form that opens as this one closes)
  useEffect(() => () => {
    if (useStrip.getState().form === said.current) useStrip.setState({ form: null });
  }, []);
  return null;
}

/** Put where things are made into a folder: the strip says where the results go. `folder` null: they are not filed. */
export function ResultsPlace({ folder }: { folder: { name: string; path: string | null } | null }) {
  const name = folder?.name;
  const path = folder?.path ?? null;
  const mine = useRef<ReturnType<typeof useStrip.getState>["place"]>(null);
  useEffect(() => {
    mine.current = name === undefined ? "unfiled" : { name, path };
    useStrip.setState({ place: mine.current });
  }, [name, path]);
  // gone: forgotten, unless another place was told since
  useEffect(() => () => {
    if (useStrip.getState().place === mine.current) useStrip.setState({ place: null });
  }, []);
  return null;
}

/** A quiet piece of the strip: grey, a wash under it on hover. Shrinks (its name truncated) when the strip is short of room. */
export const stripGhost = "inline-flex h-7 items-center gap-1.5 rounded-[9px] px-2 whitespace-nowrap text-ink-2 hover:bg-raised";
/** The model's light in the strip: green when it is what renders next, grey otherwise. */
const Light = ({ on }: { on: boolean }) => <span className={cx("size-[7px] shrink-0 rounded-full", on ? "bg-good" : "bg-ink-3")} />;
/** A model name in the strip: the first thing to go when the strip is short of room (its light and tip stay). */
const nameClass = "min-w-0 truncate max-xl:hidden";

/** In the strip: where the results of the form on screen go. */
export function StripPlace() {
  const place = useStrip((s) => s.place);
  if (!place) return null;
  return (
    <span
      className={cx(stripGhost, "min-w-0 hover:bg-transparent")}
      data-tip={place === "unfiled" ? "Not in a project and no folder open: outputs land in the Inbox. Pick a project in the rail, or open a folder, to file them." : place.path ? `Outputs land in this folder. Kept outputs become files in ${place.path}` : "Outputs land in this folder: the one that is open, or the project's root."}
    >
      <Folder size={13} className="shrink-0" />
      <span className="max-w-48 truncate font-semibold text-ink">{place === "unfiled" ? "Inbox" : place.name}</span>
    </span>
  );
}

/**
 * In the strip: the model ComfyUI holds. With a form on screen, whether that form's models are the
 * ones in memory, and the button that loads them ahead: pressed while the prompt is still being
 * written, the render then starts sampling at once. "Loaded" is what Afflatus last asked ComfyUI to
 * load: a ComfyUI restarted since is not seen.
 */
export function StripModel() {
  const form = useStrip((s) => s.form);
  const queue = useQueue();
  if (queue.data?.online === false) return null;
  // a render still bringing its model in: the model is named as it will be held, but it is not in yet
  if (queue.data?.running?.phase === "loading" && queue.data.model) return <Loading name={queue.data.model} />;
  return form ? <OfForm {...form} /> : <Held name={queue.data?.model ?? null} />;
}

/** The model the running render is loading into ComfyUI: grey until it is in. */
function Loading({ name }: { name: string }) {
  return (
    <span className={cx(stripGhost, "min-w-0 hover:bg-transparent")} data-tip={`ComfyUI is loading ${name} for the running render. It stays loaded after it, for the next one.`}>
      <Light on={false} />
      <span className="shrink-0">Loading</span>
      <span className={cx("max-w-60", nameClass)}>{name}</span>
      <span className="shrink-0">…</span>
    </span>
  );
}

/** The model that is loaded, by its name. Nothing when none is. Not `sure`: whether the open form renders with it cannot be told yet, and the icon does not say it does. */
function Held({ name, sure = true }: { name: string | null; sure?: boolean }) {
  if (!name) return null;
  if (!sure) {
    return (
      <span className={cx(stripGhost, "min-w-0 hover:bg-transparent")} data-tip={`${name}: the model ComfyUI has loaded. Whether this form renders with it cannot be told until the form is complete (a picture where one is needed).`}>
        <Light on={false} />
        <span className={cx("max-w-60", nameClass)}>{name}</span>
      </span>
    );
  }
  return (
    <span className={cx(stripGhost, "min-w-0 hover:bg-transparent")} data-tip={`${name}: the model Afflatus last had ComfyUI load. A render with it starts at once. "Unload models (free VRAM)" in the Queue unloads it. A ComfyUI restarted since is not seen.`}>
      <Light on />
      <span className={cx("max-w-60", nameClass)}>{name}</span>
    </span>
  );
}

function OfForm({ recipe, input, look }: OpenForm) {
  const queue = useQueue();
  const client = useQueryClient();
  // what the form no longer has is left out (a draft outlives a workflow whose settings were changed since)
  const has = new Set(recipe.inputs.map((i) => i.id));
  const whole = Object.fromEntries(Object.entries(input).filter(([k, v]) => has.has(k) && v !== undefined));
  // the texts do not change what is loaded: they are left out of the question, so that typing asks nothing
  const texts = new Set(recipe.inputs.filter((i) => i.type === "prompt").map((i) => i.id));
  const form = Object.fromEntries(Object.entries(whole).filter(([k]) => !texts.has(k)));
  const now = JSON.stringify([recipe.id, form, look ?? null]);
  const [asked, setAsked] = useState(now);
  useEffect(() => {
    const t = setTimeout(() => setAsked(now), 500);
    return () => clearTimeout(t);
  }, [now]);
  // asked again when a job starts or ends, or the memory is freed: what is loaded may have changed
  const jobs = `${queue.data?.running?.id ?? ""}:${queue.data?.recent[0]?.id ?? ""}:${queue.data?.model ?? ""}`;
  const loaded = useQuery({
    queryKey: queryKeys.loaded(asked, jobs),
    queryFn: () => { const [id, values, cast] = JSON.parse(asked) as [string, Record<string, unknown>, Look]; return api.loaded(id, values, cast); },
    placeholderData: keepPreviousData,
    // asked again each time the form is come back to: the memory may have been freed from the Queue
    staleTime: 0,
  });
  const load = useMutation({ mutationFn: () => api.warm(recipe.id, whole, look), onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }) });
  const stop = useStop();
  const running = queue.data?.running?.kind === "load" ? queue.data.running : null;
  const waiting = (queue.data?.waiting ?? []).find((j) => j.kind === "load");
  const state = loaded.data?.loaded;
  const held = queue.data?.model ?? null;
  // it cannot be told for this form (not complete enough to build its graph): what is loaded is still named
  if (!running && !waiting && (state === undefined || state === null) && !load.isError) return <Held name={held} sure={false} />;
  if (!running && !waiting && state) {
    return held ? <Held name={held} /> : (
      <span className={cx(stripGhost, "hover:bg-transparent")} data-tip="This form's model is what ComfyUI has loaded: the render starts sampling at once.">
        <Light on /> Model loaded
      </span>
    );
  }
  return (
    <span className={cx(stripGhost, "min-w-0 hover:bg-transparent")}>
      <Light on={false} />
      {running || waiting ? (
        <>
          <span className="truncate">{running ? "Loading model…" : "Model load queued"}</span>
          <button type="button" className="shrink-0 font-semibold text-ink underline" disabled={stop.isPending} onClick={() => stop.mutate([(running ?? waiting)!.id])}>Cancel</button>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1" data-tip={held ? `${held} is the model ComfyUI has loaded. This form renders with another model: Load swaps it in now.` : "ComfyUI has no model loaded by Afflatus."}>
            {/* short of room the name goes, and the words say it alone */}
            {held ? <><span className="shrink-0 max-xl:hidden">Loaded:</span><span className={cx("max-w-56", nameClass)}>{held}</span><span className="shrink-0 max-xl:hidden">· another model</span><span className="hidden shrink-0 max-xl:inline">Another model loaded</span></> : "Model not loaded"}
          </span>
          <button
            type="button"
            className="shrink-0 font-bold text-accent hover:underline disabled:text-ink-3 disabled:no-underline"
            data-tip="Load this form's checkpoint (or diffusion model, text encoder and VAE) into VRAM now, while you write. One step is run and nothing is saved; the render then starts at once."
            disabled={load.isPending}
            onClick={() => load.mutate()}
          >
            Load
          </button>
        </>
      )}
      {load.isError && <span className="max-w-64 truncate text-warn-ink" data-tip={load.error.message}>{load.error.message}</span>}
    </span>
  );
}
