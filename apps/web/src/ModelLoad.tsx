import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, MemoryStick } from "lucide-react";
import { create } from "zustand";
import { api, type RecipeInfo } from "./api";
import { useQueue } from "./data";
import { cx } from "./ui";

/** Stops a render that is under way, or takes one that waits out of the queue. Nothing is added. */
export function useStop() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.cancel(id);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ["queue"] }),
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
  const said = JSON.stringify([recipe.id, input, look ?? null]);
  useEffect(() => {
    useStrip.setState({ form: { recipe, input, look } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [said]);
  useEffect(() => () => useStrip.setState({ form: null }), []);
  return null;
}

/** Put where things are made into a folder: the strip says where the results go. `folder` null: they are not filed. */
export function ResultsPlace({ folder }: { folder: { name: string; path: string | null } | null }) {
  const name = folder?.name;
  const path = folder?.path ?? null;
  useEffect(() => {
    useStrip.setState({ place: name === undefined ? "unfiled" : { name, path } });
  }, [name, path]);
  useEffect(() => () => useStrip.setState({ place: null }), []);
  return null;
}

/** In the strip: where the results of the form on screen go. */
export function StripPlace() {
  const place = useStrip((s) => s.place);
  if (!place) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-ink-2"
      title={place === "unfiled" ? "Open a folder to have what you make land in it." : place.path ? `What you make lands in this folder. Kept results become files in ${place.path}` : "What you make lands in the folder that is open."}
    >
      <Folder size={13} className="shrink-0" />
      {place === "unfiled" ? <span>Results are not filed</span> : <span className="max-w-64 truncate">Results go to <span className="font-semibold text-ink">{place.name}</span></span>}
    </span>
  );
}

/**
 * In the strip: the model ComfyUI holds. With a form on screen, whether that form's models are the
 * ones in memory, and the button that loads them ahead: pressed while the prompt is still being
 * written, the render then starts sampling at once. "Loaded" is what studai last asked ComfyUI to
 * load: a ComfyUI restarted since is not seen.
 */
export function StripModel() {
  const form = useStrip((s) => s.form);
  const queue = useQueue();
  if (queue.data?.online === false) return null;
  return form ? <OfForm {...form} /> : <Held name={queue.data?.model ?? null} />;
}

/** The model that is loaded, by its name. Nothing when none is. */
function Held({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ink-2" title={`${name}: the model studai last had ComfyUI load. A render with it starts at once. "Free the GPU memory" in the Queue unloads it. A ComfyUI restarted since is not seen.`}>
      <MemoryStick size={13} className="shrink-0 text-good" />
      <span className="max-w-72 truncate">{name}</span>
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
    queryKey: ["loaded", asked, jobs],
    queryFn: () => { const [id, values, cast] = JSON.parse(asked) as [string, Record<string, unknown>, Look]; return api.loaded(id, values, cast); },
    placeholderData: keepPreviousData,
    // asked again each time the form is come back to: the memory may have been freed from the Queue
    staleTime: 0,
  });
  const load = useMutation({ mutationFn: () => api.warm(recipe.id, whole, look), onSettled: () => void client.invalidateQueries({ queryKey: ["queue"] }) });
  const stop = useStop();
  const running = queue.data?.running?.kind === "load" ? queue.data.running : null;
  const waiting = (queue.data?.waiting ?? []).find((j) => j.kind === "load");
  const state = loaded.data?.loaded;
  const held = queue.data?.model ?? null;
  // it cannot be told for this form (not complete enough to build its graph): what is loaded is still named
  if (!running && !waiting && (state === undefined || state === null) && !load.isError) return <Held name={held} />;
  if (!running && !waiting && state) {
    return held ? <Held name={held} /> : (
      <span className="flex items-center gap-1.5 text-ink-2" title="What studai last had ComfyUI load is what this form uses: the render starts sampling at once.">
        <MemoryStick size={13} className="shrink-0 text-good" /> Model loaded
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
      <MemoryStick size={13} className="shrink-0" />
      {running || waiting ? (
        <>
          <span className="truncate">{running ? "Loading the model…" : "The model loads when its turn comes"}</span>
          <button type="button" className="shrink-0 font-semibold text-ink underline" disabled={stop.isPending} onClick={() => stop.mutate([(running ?? waiting)!.id])}>Stop</button>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1" title={held ? `${held} is what ComfyUI holds. This form renders with another model.` : "ComfyUI holds no model that studai had it load."}>
            {held ? <><span className="max-w-56 truncate">{held}</span><span className="shrink-0">is loaded, not this form's model</span></> : "This form's model is not loaded"}
          </span>
          <button
            type="button"
            className={cx("shrink-0 font-semibold text-ink underline disabled:text-ink-3 disabled:no-underline")}
            title="Load this form's checkpoint (or diffusion model, text encoder and VAE) into ComfyUI's memory now, while you write. One step is run and nothing is made; the render then starts at once."
            disabled={load.isPending}
            onClick={() => load.mutate()}
          >
            Load it now
          </button>
        </>
      )}
      {load.isError && <span className="max-w-64 truncate text-warn-ink" title={load.error.message}>{load.error.message}</span>}
    </span>
  );
}
