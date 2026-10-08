import { useMemo, useState } from "react";
import { describeRecipe, folderOfFileInput, fuzzyFilter, fuzzyScore } from "@afflatus/core";
import { MODEL_FILE, recipeFromWorkflow, videoId, type Bindings, type Control, type Inspection, type Section, type Target, type Toggle, type Wiring, type WorkflowDef } from "@afflatus/workflows";
import { useSettled } from "../../hooks";
import type { Inspected } from "../MissingPacks";
import { keyOf } from "./parts";

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

/** What a video loader is in the form: the video worked on, the clip carried on from, the clip arrived at, or nothing. */
export type VideoRole = "source" | "previous" | "next" | "off";

/** The import screen's state: what was found, the mapping being made, and every change the screen can make to it. */
export function useMapping(start: Editing) {
  // read again after ComfyUI restarts with the packs it was missing
  const [found, setFound] = useState(start.inspection);
  const [title, setTitle] = useState(start.title);
  const [model, setModel] = useState(start.model);
  // a switch made here lives in a section: one no section holds any more (its section was removed, or saved by an older form) is dropped
  const [b, setB] = useState<Bindings>(() => {
    const held = new Set((start.bindings.sections ?? []).flatMap((sec) => sec.items.flatMap((it) => (typeof it === "string" ? [] : [it.toggle]))));
    return { ...start.bindings, toggles: start.bindings.toggles.filter((t) => !t.made || held.has(t.id)) };
  });
  const [filter, setFilter] = useState("");
  // the workflow itself changes in two cases: a file it names is replaced by one this ComfyUI has, and it is read again
  const [graph, setGraph] = useState(start.graph);
  const [wiring, setWiring] = useState(start.wiring);
  const replaceFile = (at: Target, file: string) => {
    setGraph((old) => ({ ...old, [at.node]: { ...old[at.node]!, inputs: { ...old[at.node]!.inputs, [at.input]: file } } }));
    setB((old) => ({ ...old, controls: old.controls.map((c) => (keyOf(c.target) === keyOf(at) ? { ...c, default: file } : c)) }));
  };
  /** The workflow read again once its packs are in: their nodes now have their fields. What was replaced here stays replaced. */
  const reread = (fresh: Inspected) => {
    setFound(fresh);
    setWiring(fresh.wiring);
    setGraph((old) => {
      const next = structuredClone(fresh.graph);
      for (const [id, n] of Object.entries(old)) {
        for (const [input, v] of Object.entries(n.inputs)) if (next[id] && typeof v === "string" && start.graph[id]?.inputs[input] !== v) next[id]!.inputs[input] = v;
      }
      return next;
    });
  };
  const [values, setValues] = useState<Record<string, unknown>>({});

  const set = (patch: Partial<Bindings>) => setB((old) => ({ ...old, ...patch }));
  /** Take a part out of the mapping (it is optional there: undefined is not a value it accepts). */
  const unset = (key: "prompt" | "negative" | "startImage" | "endImage" | "previousVideo" | "nextVideo" | "sound") =>
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
  /** The loader whose file is the form's Model picker: its file input, and ComfyUI's folder for it. */
  const modelFileOf = (node: string) => {
    const n = graph[node];
    const entry = n && Object.entries(n.inputs).find(([k, v]) => typeof v === "string" && MODEL_FILE.test(v) && folderOfFileInput(n.class_type, k));
    return entry && n ? { target: { node, input: entry[0] }, folder: folderOfFileInput(n.class_type, entry[0])! } : undefined;
  };
  const pickModel = (node: string) => {
    const m = modelFileOf(node);
    if (m) set({ model: m });
  };
  const videoRoleOf = (node: string): VideoRole =>
    b.previousVideo?.target.node === node ? "previous" : b.nextVideo?.target.node === node ? "next"
      : b.sourceVideo?.target.node === node || (b.otherVideos ?? []).some((v) => v.target.node === node) ? "source" : "off";
  const setVideoRole = (node: string, role: VideoRole) => {
    const v = found.videos.find((i) => i.node === node);
    if (!v) return;
    setB((old) => {
      // out of every role first: one loader, one role (and one loader per clip role)
      const { previousVideo, nextVideo, sourceVideo, ...rest } = old;
      const keep = <T extends { target: { node: string } } | undefined>(x: T) => (x?.target.node === node ? undefined : x);
      const others = (old.otherVideos ?? []).filter((o) => o.target.node !== node);
      let main = keep(sourceVideo);
      // the main source left: the first other one takes its place
      if (!main && others.length && sourceVideo?.target.node === node) {
        const [first, ...more] = others;
        main = { target: first!.target, detach: first!.detach, required: first!.required };
        others.splice(0, others.length, ...more);
      }
      const next: Bindings = { ...rest, otherVideos: others } as Bindings;
      const prev = role === "previous" ? v.binding : keep(previousVideo);
      const after = role === "next" ? v.binding : keep(nextVideo);
      if (prev) next.previousVideo = prev;
      if (after) next.nextVideo = after;
      if (role === "source" && !main) main = v.binding;
      else if (role === "source") next.otherVideos = [...others, { ...v.binding, id: videoId(node), label: v.title && !/^Load ?Video/i.test(v.title) ? v.title : `Video ${others.length + 2}` }];
      if (main) next.sourceVideo = main;
      return next;
    });
  };
  const pickSound = (node: string) => {
    const v = found.sounds.find((i) => i.node === node);
    // the main sound is not also one of the others
    if (v) set({ sound: v.binding, otherSounds: (b.otherSounds ?? []).filter((s) => s.target.node !== node) });
    else unset("sound");
  };
  const toggleLoras = (node: string) => {
    const on = b.loras.some((p) => p.node === node) ? b.loras.filter((p) => p.node !== node) : [...b.loras, { node, output: 0, label: "" }];
    // in the order of the workflow; several lists are told apart by the name of their model
    const points = found.loraPoints.filter((p) => on.some((x) => x.node === p.node));
    set({ loras: points.map((p) => ({ node: p.node, output: p.output, label: points.length > 1 ? p.label : "", ...(p.power ? { power: true } : {}) })) });
  };
  const toggleControl = (c: Inspection["candidates"][number]) => {
    const { classType: _c, title: _t, suggested: _s, byAuthor: _a, off: _o, ...control } = c;
    const on = b.controls.some((x) => x.id === c.id);
    set({
      controls: on ? b.controls.filter((x) => x.id !== c.id) : [...b.controls, control],
      ...(on ? { sections: (b.sections ?? []).map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (typeof it === "string" ? (it === c.id ? [] : [it]) : [{ ...it, items: it.items.filter((id) => id !== c.id) }])) })) } : {}),
    });
  };
  const change = (id: string, patch: Partial<Control>) => set({ controls: b.controls.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  // switches keep the order they have in the workflow
  const toggleSwitch = (t: Toggle) => {
    const on = b.toggles.some((x) => x.id === t.id) ? b.toggles.filter((x) => x.id !== t.id) : [...b.toggles, t];
    // the file's switches in the file's order, the ones made here after them
    set({
      toggles: [...found.toggles.flatMap((f) => on.filter((x) => x.id === f.id)), ...on.filter((x) => x.made)],
      sections: (b.sections ?? []).map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (typeof it === "string" ? (it === t.id && !on.some((x) => x.id === t.id) ? [] : [it]) : it.toggle === t.id && !on.some((x) => x.id === t.id) ? [] : [it])) })),
    });
  };
  // the form's sections, and the switches in them (made here: their nodes are the person's choice)
  const [switchFor, setSwitchFor] = useState<{ section: Section; toggle?: string } | null>(null);
  const saveSwitch = (section: Section, t: Toggle) => {
    const known = b.toggles.some((x) => x.id === t.id);
    const toggles = known ? b.toggles.map((x) => (x.id === t.id ? t : x)) : [...b.toggles, t];
    // a new switch goes at the end of its section, empty: its settings are dragged under it
    const sections = known ? b.sections : (b.sections ?? []).map((s) => (s.id === section.id ? { ...s, items: [...s.items, { toggle: t.id, items: [] }] } : s));
    set({ toggles, sections });
    setSwitchFor(null);
  };
  /** The switch leaves its section (its settings go back to the tray); one made here is forgotten altogether. */
  const dropSwitch = (section: Section, toggle: string) => {
    set({
      toggles: b.toggles.filter((x) => x.id !== toggle || !x.made),
      sections: (b.sections ?? []).map((s) => (s.id === section.id ? { ...s, items: s.items.filter((it) => typeof it === "string" || it.toggle !== toggle) } : s)),
    });
  };
  const nodeList = useMemo(() => Object.entries(graph).map(([id, n]) => ({ id, title: (n as { _meta?: { title?: string } })._meta?.title ?? n.class_type, classType: n.class_type })), [graph]);
  const changeSwitch = (id: string, patch: Partial<Toggle>) => set({ toggles: b.toggles.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  // what is already the prompt, a picture or the seed is not offered as a control too
  const taken = new Set([keyOf(b.prompt), keyOf(b.negative), ...b.seeds.map(keyOf), keyOf(b.model?.target), keyOf(b.startImage?.target), keyOf(b.endImage?.target), keyOf(b.previousVideo?.target), keyOf(b.nextVideo?.target), keyOf(b.sound?.target)]);
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

  // the form this mapping gives, made by the same code the server uses: not made again for every key typed in the
  // name (the model name settles first), and what it could not be made from is said
  const settledModel = useSettled(model);
  const preview = useMemo(() => {
    try {
      const recipe = recipeFromWorkflow({ id: "workflow.preview", title: "Preview", model: settledModel || "Preview", source: start.source, graph, wiring, bindings: b });
      return { recipe, described: describeRecipe(recipe), error: null };
    } catch (err) {
      return { recipe: null, described: null, error: (err as Error).message };
    }
  }, [b, settledModel, start.source, graph, wiring]);

  const video = b.result.kind === "video";
  // the notes that are about one switch sit under it; the rest are said with the other checks
  const noteFor = (label: string) => found.notes.filter((n) => n.includes(`"${label}"`));
  const attachedNotes = new Set(found.toggles.flatMap((t) => noteFor(t.label)));
  const looseNotes = found.notes.filter((n) => !attachedNotes.has(n));

  // a saved workflow against what its author put forward (forms saved before Afflatus followed the author, or changed since)
  const onForm = new Set(b.controls.map((c) => c.id));
  const authorDiff = {
    add: found.candidates.filter((c) => c.suggested && !onForm.has(c.id) && !taken.has(keyOf(c.target))),
    remove: b.controls.filter((x) => found.candidates.some((c) => c.id === x.id && !c.suggested)),
  };
  /** Put the author's settings on the form, or take off what the author did not put forward (off its sections too). */
  const followAuthor = (what: "add" | "remove") => {
    if (what === "add") {
      set({ controls: [...b.controls, ...authorDiff.add.map(({ classType: _c, title: _t, suggested: _s, byAuthor: _a, off: _o, ...c }) => c)] });
      return;
    }
    const gone = new Set(authorDiff.remove.map((c) => c.id));
    set({
      controls: b.controls.filter((c) => !gone.has(c.id)),
      sections: (b.sections ?? []).map((s) => ({ ...s, items: s.items.flatMap((it): Section["items"] => (typeof it === "string" ? (gone.has(it) ? [] : [it]) : [{ ...it, items: it.items.filter((id) => !gone.has(id)) }])) })),
    });
  };

  return {
    start, found, reread, authorDiff, followAuthor, title, setTitle, model, setModel, b, set, unset, filter, setFilter, graph, wiring, replaceFile, values, setValues,
    textOptions, pickText, pickImage, modelFileOf, pickModel, videoRoleOf, setVideoRole, pickSound, toggleLoras, toggleControl, change, toggleSwitch,
    switchFor, setSwitchFor, saveSwitch, dropSwitch, nodeList, changeSwitch, taken, groups, switches, preview, video, noteFor, looseNotes,
  };
}

export type Mapping = ReturnType<typeof useMapping>;
