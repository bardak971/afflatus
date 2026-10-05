import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
import { folderOfFileInput, fuzzyFilter, fuzzyScore, isShown } from "@afflatus/core";
import { recipeFromWorkflow, type Bindings, type Control, type Inspection, type Target, type Toggle, type Wiring, type WorkflowDef } from "@afflatus/workflows";
import { api } from "../api";
import { defaultOf, Field } from "../fields";
import { fileLabel } from "../format";
import { GetFile } from "../GetFile";
import { Select } from "../Select";
import { Button, cx, ErrorNote, Help, SectionTitle, Note } from "../ui";

/** A workflow being imported or changed: the file, what was found in it, and the mapping so far. */
export interface Editing {
  /** Set when a saved workflow is being changed: saving replaces it. */
  id: string | null;
  source: string;
  title: string;
  model: string;
  graph: WorkflowDef["graph"];
  /** What the editor's own file knew (switched-off parts, switches), when the workflow came from one. */
  wiring?: Wiring;
  /** The editor's own file itself, kept so that ComfyUI can open the workflow as it was. */
  editor?: unknown;
  inspection: Inspection;
  bindings: Bindings;
}

const keyOf = (t: Target | undefined) => (t ? `${t.node}.${t.input}` : "");
const link = "font-semibold text-accent underline underline-offset-2 hover:text-ink";
/** Where to look for a model file by its name, when the workflow does not say where it comes from. */
const searchLinks = (file: string) => [
  { label: "Civitai", url: `https://civitai.com/search/models?query=${encodeURIComponent(fileLabel(file))}` },
  { label: "Hugging Face", url: `https://huggingface.co/models?search=${encodeURIComponent(fileLabel(file))}` },
];
const text = "h-10 w-full rounded-lg border border-line bg-raised px-3";

/** One thing Afflatus looked for: a mark that says whether it has it, its name, and how to change it. */
function Found({ ok, role, note, children }: { ok: boolean; role: string; note?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", ok ? "bg-good/20 text-good" : "bg-hover text-ink-2")}>
          {ok ? <Check size={12} strokeWidth={3} /> : <Minus size={12} strokeWidth={3} />}
        </span>
        <span className="font-semibold">{role}</span>
        <Note text={note} />
      </div>
      {children}
    </div>
  );
}

/** What a control lets you set, in a few words. */
function rangeOf(c: Control): string {
  if (c.kind === "number") return `a number, ${c.min ?? 0} to ${c.max ?? 100}`;
  if (c.kind === "toggle") return "on or off";
  if (c.kind === "choice") return c.file ? "one of the model files in your ComfyUI" : "one of the choices ComfyUI offers";
  return "text";
}

export function WorkflowEditor({ start, onDone }: { start: Editing; onDone(saved: boolean): void }) {
  const found = start.inspection;
  /** What says which model a missing file is for: its loader's "type", and the model the workflow is for. */
  const hintsFor = (node: string) => [graph[node]?.inputs.type, model].filter((x): x is string => typeof x === "string" && x.trim().length > 2 && x !== "default");
  /** Where ComfyUI looks for a file that is missing, and where else it has one of that name. */
  const where = (f: { file: string; classType: string; input: string }) => {
    const folder = folderOfFileInput(f.classType, f.input);
    const others = ((found as { elsewhere?: Record<string, string[]> }).elsewhere?.[f.file] ?? []).filter((x) => x !== folder);
    if (others.length) {
      return `ComfyUI has a file of this name in its "${others.join('", "')}" folder, but this loader only looks in "${folder ?? "its own folder"}". Move the file there, or tell ComfyUI that the folder also holds that kind of model (its extra_model_paths.yaml), then restart ComfyUI.`;
    }
    return folder ? `This loader only looks in ComfyUI's "models/${folder}" folders: put the file there, then test again in Settings.` : "It goes in ComfyUI's models folder; then test again in Settings.";
  };
  const client = useQueryClient();
  const [title, setTitle] = useState(start.title);
  const [model, setModel] = useState(start.model);
  const [b, setB] = useState<Bindings>(start.bindings);
  const [filter, setFilter] = useState("");
  // the workflow itself changes in one case: a file it names is replaced by one this ComfyUI has
  const [graph, setGraph] = useState(start.graph);
  const replaceFile = (at: Target, file: string) => {
    setGraph((old) => ({ ...old, [at.node]: { ...old[at.node]!, inputs: { ...old[at.node]!.inputs, [at.input]: file } } }));
    setB((old) => ({ ...old, controls: old.controls.map((c) => (keyOf(c.target) === keyOf(at) ? { ...c, default: file } : c)) }));
  };
  const [values, setValues] = useState<Record<string, unknown>>({});

  const set = (patch: Partial<Bindings>) => setB((old) => ({ ...old, ...patch }));
  /** Take a part out of the mapping (it is optional there: undefined is not a value it accepts). */
  const unset = (key: "prompt" | "negative" | "startImage" | "endImage") =>
    setB((old) => {
      const { [key]: _gone, ...rest } = old;
      return rest as Bindings;
    });

  const textOptions = found.texts.map((t) => ({ key: keyOf(t.target), label: `${t.title} #${t.target.node}${t.text ? ` · "${t.text.slice(0, 32)}${t.text.length > 32 ? "…" : ""}"` : ""}`, target: t.target }));
  const pickText = (key: "prompt" | "negative") => (value: string) => {
    const t = textOptions.find((o) => o.key === value);
    if (t) set({ [key]: t.target });
    else unset(key);
  };
  const pickImage = (key: "startImage" | "endImage") => (node: string) => {
    const image = found.images.find((i) => i.node === node);
    if (image) set({ [key]: image.binding });
    else unset(key);
  };
  const toggleLoras = (node: string) => {
    const on = b.loras.some((p) => p.node === node) ? b.loras.filter((p) => p.node !== node) : [...b.loras, { node, output: 0, label: "" }];
    // in the order of the workflow; several lists are told apart by the name of their model
    const points = found.loraPoints.filter((p) => on.some((x) => x.node === p.node));
    set({ loras: points.map((p) => ({ node: p.node, output: p.output, label: points.length > 1 ? p.label : "", ...(p.power ? { power: true } : {}) })) });
  };
  const toggleControl = (c: Inspection["candidates"][number]) => {
    const { classType: _c, title: _t, suggested: _s, off: _o, ...control } = c;
    set({ controls: b.controls.some((x) => x.id === c.id) ? b.controls.filter((x) => x.id !== c.id) : [...b.controls, control] });
  };
  const change = (id: string, patch: Partial<Control>) => set({ controls: b.controls.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  // switches keep the order they have in the workflow
  const toggleSwitch = (t: Toggle) => {
    const on = b.toggles.some((x) => x.id === t.id) ? b.toggles.filter((x) => x.id !== t.id) : [...b.toggles, t];
    set({ toggles: found.toggles.flatMap((f) => on.filter((x) => x.id === f.id)) });
  };
  const changeSwitch = (id: string, patch: Partial<Toggle>) => set({ toggles: b.toggles.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  // what is already the prompt, a picture or the seed is not offered as a control too
  const taken = new Set([keyOf(b.prompt), keyOf(b.negative), ...b.seeds.map(keyOf), keyOf(b.startImage?.target), keyOf(b.endImage?.target)]);
  const groups = useMemo(() => {
    const map = new Map<string, Inspection["candidates"]>();
    for (const c of found.candidates) {
      if (fuzzyScore(filter, `${c.label} ${c.title} ${c.classType} ${c.target.input}`) === null) continue;
      map.set(c.target.node, [...(map.get(c.target.node) ?? []), c]);
    }
    // nodes with a control that was ticked when the screen opened come first; they do not jump around while ticking
    const first = (items: Inspection["candidates"]) => (items.some((c) => start.bindings.controls.some((x) => x.id === c.id)) ? 0 : 1);
    return [...map.entries()].sort((a, z) => first(a[1]) - first(z[1]));
  }, [found.candidates, filter, start.bindings.controls]);

  const switches = useMemo(() => fuzzyFilter(found.toggles, filter, (t) => `${b.toggles.find((x) => x.id === t.id)?.label ?? ""} ${t.label} ${t.captions?.on ?? ""} ${t.captions?.off ?? ""}`), [found.toggles, filter, b.toggles]);

  // the form this mapping gives, made by the same code the server uses
  const preview = useMemo(() => {
    try {
      return recipeFromWorkflow({ id: "workflow.preview", title: title || "Preview", model: model || "Preview", source: start.source, graph, wiring: start.wiring, bindings: b });
    } catch {
      return null;
    }
  }, [b, title, model, start, graph]);

  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), model: model.trim(), source: start.source, graph, wiring: start.wiring, editor: start.editor, bindings: b };
      return start.id ? api.saveWorkflow(start.id, body) : api.createWorkflow(body);
    },
    onSuccess: async () => {
      await Promise.all(["recipes", "setup", "workflows"].map((key) => client.invalidateQueries({ queryKey: [key] })));
      onDone(true);
    },
  });

  // the preview behaves like the real form: a setting of a part that is switched off is hidden
  const shown = useMemo(() => {
    const all = Object.fromEntries((preview?.inputs ?? []).map((i) => [i.id, values[i.id] ?? defaultOf(i, undefined)]));
    return (preview?.inputs ?? []).filter((i) => isShown(i, all)).map((i) => ({ spec: i, value: all[i.id] }));
  }, [preview, values]);

  const result = found.outputs.find((o) => o.node === b.result.node);
  const video = b.result.kind === "video";
  const canSave = title.trim() && model.trim() && !save.isPending;

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex h-20 shrink-0 items-center gap-4 border-b border-line px-8">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-xl font-semibold">{start.id ? "Edit workflow" : "Import ComfyUI workflow"}</h1>
          <div className="truncate text-ink-2">{start.source || start.title} · {found.nodeCount} nodes · Afflatus read it and mapped the parts below. Correct anything that is wrong.</div>
        </div>
        <span className="grow" />
        <Button onClick={() => onDone(false)}>Cancel</Button>
        <Button tone="primary" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : start.id ? "Save changes" : "Save workflow"}</Button>
      </header>

      <div className="grid min-h-0 grow grid-cols-[minmax(0,1fr)_minmax(0,1fr)_400px]">
        <section className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-line p-5">
          <SectionTitle>Mapping</SectionTitle>

          <Found ok={Boolean(b.prompt)} role="Prompt" note={b.prompt ? undefined : "No text input (CLIP Text Encode or similar) was found."}>
            {textOptions.length > 0 && (
              <Select size="sm" label="Node the prompt goes to" value={keyOf(b.prompt)} onChange={pickText("prompt")} options={[{ value: "", label: "None" }, ...textOptions.map((o) => ({ value: o.key, label: o.label }))]} />
            )}
          </Found>
          <Found ok={Boolean(b.negative)} role="Negative prompt" note={b.negative ? undefined : "optional"}>
            {textOptions.length > 0 && (
              <Select size="sm" label="Node the negative prompt goes to" value={keyOf(b.negative)} onChange={pickText("negative")} options={[{ value: "", label: "None" }, ...textOptions.map((o) => ({ value: o.key, label: o.label }))]} />
            )}
          </Found>

          {(["startImage", "endImage"] as const).map((key) => {
            const bound = b[key];
            const role = key === "startImage" ? (video ? "First frame" : "Image") : "Last frame";
            if (!found.images.length) return key === "startImage" ? <Found key={key} ok={false} role={role} note="This workflow has no Load Image node." /> : null;
            return (
              <Found key={key} ok={Boolean(bound)} role={role} note={bound ? (bound.required ? "required" : "optional") : undefined}>
                <Select size="sm" label={role} value={bound?.target.node ?? ""} onChange={pickImage(key)} options={[{ value: "", label: "None" }, ...found.images.map((i) => ({ value: i.node, label: i.title, note: `#${i.node}` }))]} />
              </Found>
            );
          })}

          {(() => {
            // every other picture it loads: a slot each in the form, unless it is ticked off
            const main = new Set([b.startImage?.target.node, b.endImage?.target.node]);
            const rest = found.images.filter((i) => !main.has(i.node) && i.role !== "mask");
            if (!rest.length) return null;
            const idOf = (node: string) => `pic_${node}`.replace(/[^a-zA-Z0-9_]/g, "_");
            const have = b.pictures ?? [];
            return (
              <Found ok={have.length > 0} role="Other Load Image nodes" note={`${have.length} of ${rest.length} in the form`}>
                {rest.map((i, n) => {
                  const on = have.find((p) => p.target.node === i.node);
                  return (
                    <label key={i.node} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(on)}
                        onChange={() => set({ pictures: on ? have.filter((p) => p !== on) : [...have, { ...i.binding, id: idOf(i.node), label: i.title && !/^Load ?Image/i.test(i.title) ? i.title : `Image ${n + 2}` }] })}
                      />
                      {on ? (
                        <input
                          aria-label={`Label of the image input for ${i.title}`}
                          value={on.label}
                          onChange={(e) => set({ pictures: have.map((p) => (p === on ? { ...p, label: e.target.value } : p)) })}
                          className={cx(text, "h-8 min-w-0 grow")}
                        />
                      ) : <span className="text-ink-2">{i.title}</span>}
                      <span className="shrink-0 text-xs text-ink-3">#{i.node}{on ? (on.required ? " · required" : " · optional") : ""}</span>
                    </label>
                  );
                })}
              </Found>
            );
          })()}

          <Found
            ok={Boolean(b.size)}
            role="Resolution"
            note={b.size ? `width and height of node #${b.size.width.node}` : "The workflow sets its own resolution. Its width and height are in the list on the right."}
          />
          {video && (
            <Found
              ok={Boolean(b.length)}
              role="Duration"
              note={b.length ? `in seconds, at ${b.length.fps} fps` : "The workflow sets its own frame count. Look for its length setting in the list on the right."}
            />
          )}
          <Found
            ok={b.seeds.length > 0}
            role="Seed"
            note={b.seeds.length ? (b.seeds.length > 1 ? `${b.seeds.length} nodes, all given the same seed` : `node #${b.seeds[0]!.node}`) : "None found: every render would come out the same."}
          />

          <Found ok={b.loras.length > 0} role="LoRA loaders" note={found.loraPoints.length ? (b.loras.length > 1 ? "one list for each" : undefined) : "No model loader was found."}>
            {found.loraPoints.map((p) => (
              <label key={p.node} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={b.loras.some((x) => x.node === p.node)} onChange={() => toggleLoras(p.node)} className="accent-accent" />
                {p.power
                  ? <span><span className="font-semibold">{p.label || p.title}</span> <span className="text-ink-3">#{p.node}</span> · the workflow's own list: its LoRAs start in yours</span>
                  : <span>after <span className="font-semibold">{p.label}</span> <span className="text-ink-3">#{p.node}</span></span>}
              </label>
            ))}
          </Found>

          <Found ok role="Output" note={`${b.result.kind === "image" ? "an image" : b.result.kind === "video" ? (b.result.sound ? "a video with audio" : "a video without audio") : "audio"}`}>
            {found.outputs.length > 1 && (
              <Select
                size="sm"
                label="Output node"
                value={b.result.node}
                onChange={(node) => {
                  const o = found.outputs.find((x) => x.node === node);
                  if (o) set({ result: { node: o.node, kind: o.kind, sound: o.sound } });
                }}
                options={found.outputs.map((o) => ({ value: o.node, label: o.title, note: `#${o.node} · ${o.kind}` }))}
              />
            )}
            {found.outputs.length > 1 && <span className="text-xs text-ink-2">This workflow has {found.outputs.length} output nodes. Only this one goes to your library.</span>}
            {!result && <ErrorNote>The output node is no longer in the workflow.</ErrorNote>}
          </Found>
        </section>

        <section className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-line p-5">
          <input data-search
            aria-label="Search switches and widgets"
            placeholder={`Search ${found.toggles.length ? `${found.toggles.length} switches and ` : ""}${found.candidates.length} widgets`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={cx(text, "sticky top-0 z-10 h-9 shrink-0 shadow-[0_0_0_8px_var(--color-ground)]")}
          />
          {found.toggles.length > 0 && (
            <>
              <SectionTitle>Switches (bypass groups)</SectionTitle>
              <div className="text-ink-2">Parts of this workflow that can be bypassed. Each ticked one becomes a switch in the form. {b.toggles.length} of {found.toggles.length} ticked.</div>
              {!switches.length && <div className="text-ink-2">No switch matches.</div>}
              {switches.map((t) => {
                const ticked = b.toggles.find((x) => x.id === t.id);
                const nodes = t.effects.reduce((n, e) => n + e.nodes.length, 0);
                return (
                  <div key={t.id} className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2", ticked ? "border-accent/50 bg-accent-wash" : "border-line bg-panel")}>
                    <input type="checkbox" aria-label={`Add the switch ${t.label}`} checked={Boolean(ticked)} onChange={() => toggleSwitch(t)} className="accent-accent" />
                    {t.help && <Help text={t.help} />}
                    {ticked ? (
                      <>
                        <input aria-label="Name of the switch" value={ticked.label} onChange={(e) => changeSwitch(t.id, { label: e.target.value })} className="h-7 min-w-0 grow rounded-md border border-line bg-raised px-2 font-semibold" />
                        <button type="button" aria-pressed={Boolean(ticked.front)} onClick={() => changeSwitch(t.id, { front: !ticked.front })} className="h-7 shrink-0 rounded-md border border-line px-2 text-xs text-ink-2 hover:text-ink">
                          {ticked.front ? "Shown up front" : "Under Advanced"}
                        </button>
                      </>
                    ) : (
                      <span className="min-w-0 grow truncate font-semibold">{t.label}</span>
                    )}
                    <span className="shrink-0 text-xs text-ink-2">{t.default ? "active" : "bypassed"} in the file · {nodes} node{nodes === 1 ? "" : "s"}</span>
                  </div>
                );
              })}
              <div className="pt-3" />
            </>
          )}
          {(found.stages?.length ?? 0) > 1 && found.stages.at(-1)!.node === b.result.node && (() => {
            // a workflow with a preview on the way can stop there: hires fix as a switch when that is what its second half is
            const hires = found.stages.length === 2 && found.stages[0]!.label === "Hires fix off";
            const on = (b.stages?.length ?? 0) > 1;
            return (
              <>
                <SectionTitle>{hires ? "Hires fix" : "Partial run"}</SectionTitle>
                <div className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2", on ? "border-accent/50 bg-accent-wash" : "border-line bg-panel")}>
                  <input type="checkbox" aria-label={hires ? "Add a Hires fix switch" : "Add a Run choice"} checked={on} onChange={() => set({ stages: on ? [] : found.stages })} className="accent-accent" />
                  <span className="min-w-0 grow font-semibold">{hires ? "Hires fix" : "Run"}</span>
                  <span className="shrink-0 text-xs text-ink-2">{hires ? "a switch · on in the file" : `a choice of ${found.stages.length}`}</span>
                </div>
                <div className="text-ink-2">
                  {hires
                    ? "This workflow is a base pass, then an upscale and a second sampling pass over the larger latent. Ticked, the form gets a Hires fix switch: off runs the base pass only, and the upscale and second-pass widgets are hidden."
                    : `This workflow has a Preview node at ${found.stages.length} points on the way. Ticked, the form gets a "Run" choice (${found.stages.map((st) => st.label).join(" / ")}): what comes after the chosen point is not run.`}
                </div>
                <div className="pt-3" />
              </>
            );
          })()}
          <SectionTitle>Widgets exposed in the form</SectionTitle>
          <div className="text-ink-2">Tick a widget to get a control for it. {b.controls.length} ticked. Everything else stays as it is in the file. A "?" is what the node's author says about it; it follows the widget into the form.</div>
          {groups.map(([node, items]) => (
            <div key={node} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 pt-1.5 text-xs text-ink-2">
                <span>{items[0]!.title} <span className="text-ink-3">#{node}</span></span>
                {found.about?.[items[0]!.classType] && <Help text={found.about[items[0]!.classType]!} />}
              </div>
              {items.map((c) => {
                const ticked = b.controls.find((x) => x.id === c.id);
                const used = taken.has(keyOf(c.target));
                return (
                  <div key={c.id} className={cx("flex items-center gap-2.5 rounded-lg border px-3 py-2", ticked ? "border-accent/50 bg-accent-wash" : "border-line bg-panel", used && "opacity-50")}>
                    <input type="checkbox" aria-label={`Add a control for ${c.label}`} checked={Boolean(ticked)} disabled={used} onChange={() => toggleControl(c)} className="accent-accent" />
                    {c.help && <Help text={c.help} />}
                    {ticked ? (
                      <>
                        <input aria-label="Name of the control" value={ticked.label} onChange={(e) => change(c.id, { label: e.target.value })} className="h-7 min-w-0 grow rounded-md border border-line bg-raised px-2 font-semibold" />
                        <button type="button" aria-pressed={Boolean(ticked.front)} onClick={() => change(c.id, { front: !ticked.front })} className="h-7 shrink-0 rounded-md border border-line px-2 text-xs text-ink-2 hover:text-ink">
                          {ticked.front ? "Shown up front" : "Under Advanced"}
                        </button>
                      </>
                    ) : (
                      <span className="min-w-0 grow truncate font-semibold">{c.label}</span>
                    )}
                    {!ticked && <span className="shrink-0 text-xs text-ink-2">{used ? "already mapped on the left" : `${rangeOf(c)}${c.off ? " · in a bypassed part" : ""}`}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {!groups.length && <div className="text-ink-2">{filter ? "No widget matches." : "This workflow has no other widget that can be exposed."}</div>}
        </section>

        <section className="flex min-h-0 flex-col gap-3.5 overflow-y-auto bg-panel p-5">
          <SectionTitle>Form preview</SectionTitle>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wf-title" className="text-xs font-semibold">Name</label>
            <input id="wf-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="i2v" className={text} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wf-model" className="text-xs font-semibold">Model</label>
            <input id="wf-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Wan 2.2" className={text} />
            <span className={cx("text-xs", model.trim() ? "text-ink-2" : "text-accent")}>{model.trim() ? "Workflows with the same model name are grouped together." : "Name the model it uses (\"Wan 2.2\", \"Qwen Image\") to be able to save."}</span>
          </div>

          <div className="flex flex-col gap-1.5 text-xs">
            {found.missingNodes.length ? (
              <div role="alert" className="flex flex-col gap-1.5 rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">
                <span>Your ComfyUI is missing {found.missingNodes.length} node type{found.missingNodes.length > 1 ? "s" : ""} this workflow uses. You can save it, but it cannot run until they are installed (ComfyUI-Manager has "Install missing custom nodes").</span>
                {found.missingNodes.map((n) => (
                  <span key={n}>
                    <span className="font-semibold">{n}</span>
                    {found.packs[n]
                      ? <> · from the node pack <a className={link} href={`https://registry.comfy.org/nodes/${encodeURIComponent(found.packs[n]!)}`} target="_blank" rel="noreferrer">{found.packs[n]}</a></>
                      : <> · <a className={link} href={`https://github.com/search?q=${encodeURIComponent(`"${n}" comfyui`)}&type=code`} target="_blank" rel="noreferrer">search GitHub</a></>}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-good">Every node type it uses is installed in your ComfyUI.</span>
            )}
            {found.missingFiles.map((f) => {
              const now = String(graph[f.node]?.inputs[f.input] ?? f.file);
              const replaced = now !== f.file;
              return (
                <div key={keyOf(f)} className={cx("flex flex-col gap-1.5 rounded-lg px-3 py-2", replaced ? "border border-line text-ink-2" : "bg-warn-wash text-warn-ink")}>
                  <span>
                    {replaced ? "Replaced: " : "Your ComfyUI does not have "}
                    <span className="font-semibold break-all">{fileLabel(f.file)}</span> ({f.label}).
                    {!replaced && " Use another file, or download this one:"}
                  </span>
                  <Select
                    size="sm"
                    label={`File to use instead of ${fileLabel(f.file)}`}
                    placeholder="Replace with…"
                    value={replaced ? now : ""}
                    onChange={(file) => replaceFile(f, file || f.file)}
                    options={[...(replaced ? [{ value: "", label: "Back to the file the workflow names" }] : []), ...f.options.map((o) => ({ value: o, label: fileLabel(o), note: o.split(/[\\/]/).slice(0, -1).join("/") || undefined }))]}
                  />
                  {!replaced && (
                    <span>
                      {f.url
                        ? <a className={link} href={f.url} target="_blank" rel="noreferrer">Download it (the URL is in the workflow)</a>
                        : <>Search for it on {searchLinks(f.file).map((l, i) => <span key={l.url}>{i > 0 && " or "}<a className={link} href={l.url} target="_blank" rel="noreferrer">{l.label}</a></span>)}</>}
                      . {where(f)}
                      <GetFile file={f.file} folder={folderOfFileInput(f.classType, f.input)} url={f.url} hints={hintsFor(f.node)} />
                    </span>
                  )}
                </div>
              );
            })}
            {(found.missingChoices ?? []).map((c) => {
              const now = String(graph[c.node]?.inputs[c.input] ?? c.value);
              const replaced = now !== c.value;
              const what = c.input.replace(/_/g, " ");
              return (
                <div key={keyOf(c)} className={cx("flex flex-col gap-1.5 rounded-lg px-3 py-2", replaced ? "border border-line text-ink-2" : "bg-warn-wash text-warn-ink")}>
                  <span>
                    {replaced ? <>Replaced: <span className="font-semibold">{c.value}</span> by <span className="font-semibold">{now}</span> as {what} ({c.title}).</> : (
                      <>Your ComfyUI does not offer <span className="font-semibold">{c.value}</span> as {what} ({c.title} #{c.node}). It comes from a node pack this ComfyUI does not have, and the prompt would be rejected. Use another:</>
                    )}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!replaced && c.nearest && <Button size="sm" tone="primary" onClick={() => replaceFile(c, c.nearest!)}>Use {c.nearest}, the closest match</Button>}
                    <div className="min-w-48 grow">
                      <Select
                        size="sm"
                        label={`What to use as ${what} instead of ${c.value}`}
                        placeholder="Pick another…"
                        value={replaced ? now : ""}
                        onChange={(v) => replaceFile(c, v || c.value)}
                        options={c.options.map((o) => ({ value: o, label: o }))}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            {(found.relocated ?? []).map((r) => (
              <div key={keyOf(r)} className="rounded-lg border border-line px-3 py-2 text-ink-2">
                <span className="font-semibold break-all text-ink">{fileLabel(r.file)}</span> is in your ComfyUI in another folder ({r.found.split(/[\\/]/).slice(0, -1).join("/") || "the top one"}): it is used from there.
              </div>
            ))}
            {found.missingFiles.length > 0 && found.links.length > 0 && (
              <details className="rounded-lg border border-line px-3 py-2 text-ink-2">
                <summary className="cursor-pointer">Links the workflow's author left in its notes ({found.links.length})</summary>
                <div className="flex flex-col gap-1 pt-2">
                  {found.links.map((l) => <a key={l.url} className={cx(link, "font-normal break-words")} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}
                </div>
              </details>
            )}
            {found.missingWhenOn.length > 0 && (
              <span className="text-ink-2">
                Bypassed parts use node types your ComfyUI does not have: {found.missingWhenOn.map((n) => (found.packs[n] ? `${n} (pack ${found.packs[n]})` : n)).join(", ")}. Those switches will not work until they are installed.
              </span>
            )}
            {found.notes.map((n) => <ErrorNote key={n}>{n}</ErrorNote>)}
          </div>

          <div className="flex flex-col gap-3.5 rounded-xl border border-line bg-ground p-3.5">
            {shown.map(({ spec, value }) => (
              <Field key={spec.id} spec={spec} value={value} options={found.candidates.find((c) => c.id === spec.id)?.offers} onChange={(v) => setValues((old) => ({ ...old, [spec.id]: v }))} />
            ))}
            {preview && !preview.inputs.length && <span className="text-ink-2">No inputs: it would always generate the same output.</span>}
            {!preview && <ErrorNote>This mapping cannot be previewed. Check the mapping on the left.</ErrorNote>}
          </div>

          {preview?.traits && (
            <div className="flex flex-col gap-1 text-xs text-ink-2">
              <span className="font-semibold text-ink">In a timeline, a clip generated with it</span>
              <span>{preview.traits.startFrame ? "takes a first frame, and can extend the previous clip from its last frame" : "takes no first frame"}</span>
              <span>{preview.traits.endFrame ? "takes a last frame" : "takes no last frame"}</span>
              <span>{preview.traits.sound ? "has audio" : "has no audio"}</span>
            </div>
          )}

          {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        </section>
      </div>
    </div>
  );
}
