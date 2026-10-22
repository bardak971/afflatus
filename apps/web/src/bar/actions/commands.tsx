import { Bell, LogOut, Bookmark, ChevronLeft, ChevronRight, Clapperboard, CircleDollarSign, Download, Eye, FileOutput, FileUp, Film, FlipHorizontal2, FolderPlus, Gauge, Layers, Link2, MemoryStick, Pause, PenLine, Play, Plug, RotateCcw, Search, Server, Sparkles, Split, Square, Trash2, Undo2, Wand2, X } from "lucide-react";
import { TRANSITIONS, withinPixels } from "@afflatus/core";
import { ask } from "../../Confirm";
import { openFindModels } from "../../findModels/store";
import { askGoBack, followRestart, useUpdatesSeen } from "../../updates";
import { settingHref } from "../../screens/settings/settingsIndex";
import { billing, signOutBlock } from "../commandRows";
import { missingActions, onThisPc, pickedActions } from "./models";
import { cancelHunt, openDeploy } from "../../deploy";
import { openLoadPanel } from "../../loadPanelHost";
import { OPEN_MACHINES } from "../../MachinesPill";
import { api, type RecipeInfo } from "../../api";
import { emptyAll, restoreAll } from "../../binActions";
import { snapEdge } from "../../fields/SizeField";
import { wholeForm } from "../../form";
import { useFormTarget } from "../../formTarget";
import { plural, size, usd } from "../../format";
import { rowKeys } from "../../keys/table";
import { projectForNew, useProject } from "../../project";
import { unloadBlock } from "../../queueRules";
import { machineByName, machineLabel, machinesByName, machineUnloadBlock, rateSaid, rentedSaid } from "../../machines";
import type { Target } from "../../projects/tree";
import { kitHref } from "../../screens/kit/link";
import { openFolderId, useBanners } from "../../store";
import { useTimelineRequest, useWorkflowsRequest, type TimelineRequest } from "../bridge";
import { KIT_OF, type Command, type KitNew } from "../parse";
import type { Action, BarCtx, Preset } from "./ctx";
import { applyPreset } from "./kit";
import { row } from "./tree";
import { queryKeys } from "../../queryKeys";
import { PIN_WORDS } from "../../timeline/model";

const KIT_WORD = { person: "person", place: "place", style: "style", preset: "preset", snippet: "snippet" } as const;

/** A command with its figures: what it does, then (Ctrl + Enter) where it does it. */
export function commandActions(x: BarCtx, c: Command, recipe?: RecipeInfo, preset?: Preset): Action[] {
  const { aim, client, go, say, good, failed, form, noDraft, askTimeline, atTopAction, tree, queue, ops, openComfy, rented, deployAgain } = x;
  const noTimeline: Action = { label: "No timeline to do it on", disabled: true, run: () => {} };
  switch (c.cmd) {
    case "render-clips":
    case "render-missing": {
      if (!aim) return [noTimeline];
      // on one ComfyUI of several this once, by its name: the request carries it to the editor
      const m = c.machine ? machineByName(queue?.machines, c.machine) : undefined;
      if (c.machine && !m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <Play size={14} />, disabled: true, run: () => {} }];
      const on = m ? { machine: m.id } : {};
      const where = m ? ` on ${machineLabel(m)}` : "";
      const ask = c.cmd === "render-clips" ? { timeline: aim.id, do: "render" as const, clips: c.clips, ...on } : { timeline: aim.id, do: "render-missing" as const, ...on };
      const what = c.cmd === "render-clips" ? `Render clip${c.clips.length > 1 ? "s" : ""} ${c.clips.join(", ")} of ${aim.name}` : `Render missing clips of ${aim.name}`;
      return [
        { label: `${what}${where}`, icon: <Play size={14} />, note: "at the end of the queue", run: () => askTimeline(aim, ask) },
        atTopAction(aim, ask),
        { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
      ];
    }
    case "export":
      return aim ? [
        { label: `Export ${aim.name}…`, icon: <FileOutput size={14} />, note: "the export dialog opens", run: () => askTimeline(aim, { timeline: aim.id, do: "export" }) },
        { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
      ] : [noTimeline];
    case "export-editor":
      return aim ? [
        { label: `Export ${aim.name} for a video editor…`, icon: <FileOutput size={14} />, note: "the export dialog opens on For an editor", run: () => askTimeline(aim, { timeline: aim.id, do: "export", editor: true }) },
        { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
      ] : [noTimeline];
    case "finish":
      return aim ? [
        { label: `Finish ${aim.name}…`, icon: <Sparkles size={14} />, note: "the Finish dialog opens", run: () => askTimeline(aim, { timeline: aim.id, do: "finish" }) },
        { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
      ] : [noTimeline];
    case "fix-all":
      return aim ? [
        { label: `Fix all in ${aim.name}`, icon: <Wand2 size={14} />, note: "as Needs a look's Fix all", run: () => askTimeline(aim, { timeline: aim.id, do: "fix-all" }) },
        { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
      ] : [noTimeline];
    case "bin-unused": {
      const e = aim?.entry;
      return e ? [{ label: `Bin unused takes of ${e.label}…`, icon: <Trash2 size={14} />, danger: true, disabled: !e.unusedTakes, note: e.unusedTakes ? `${e.unusedTakes} · ${size(e.unusedBytes)}` : "none", run: () => tree.binUnused(row(e, { unused: { takes: e.unusedTakes, bytes: e.unusedBytes } })) }] : [noTimeline];
    }
    case "seed":
    case "steps":
    case "cfg":
    case "size":
    case "length": {
      const set = async () => {
        const t = await form();
        if (!t) return say({ id: "bar:form", tone: "bad", title: "No draft is open", text: "Open a draft in the Studio first: the command sets a value of its form.", href: "/", go: "Open the Studio" });
        const inputs = t.recipe.inputs;
        const spec =
          c.cmd === "seed" ? inputs.find((i) => i.type === "seed")
          : c.cmd === "size" ? inputs.find((i) => i.type === "size" && !i.ratioOnly)
          : c.cmd === "length" ? inputs.find((i) => i.type === "number" && (i.id === "seconds" || /^(length|seconds|duration)$/i.test(i.label)))
          : c.cmd === "steps" ? inputs.find((i) => i.type === "number" && (/^steps$/i.test(i.id) || /^steps$/i.test(i.label)))
          : inputs.find((i) => i.type === "number" && (/^(cfg|guidance)$/i.test(i.id) || /^(cfg|guidance)$/i.test(i.label)));
        if (!spec) return say({ id: "bar:form", tone: "bad", title: `${t.recipe.title} has no ${c.cmd === "cfg" ? "CFG" : c.cmd} to set`, text: c.cmd === "size" ? "Its frame is set by proportions and a resolution: choose them in the form." : undefined, href: "/", go: "Open the Studio" });
        // a size goes in as the size field keeps a typed one: each edge on the recipe's grid, within its least and most
        const where = `In the open draft (${t.recipe.title}).`;
        if (c.cmd === "size") {
          if (spec.type !== "size") return;
          const edges = { width: snapEdge(spec, c.width), height: snapEdge(spec, c.height) };
          // and within the most pixels the model takes, as the render holds it
          const fit = spec.maxPixels ? withinPixels(edges, { grid: spec.grid, maxPixels: spec.maxPixels, min: spec.min }) : edges;
          t.set(spec.id, fit);
          const moved = fit.width !== c.width || fit.height !== c.height;
          return good(`${spec.label || "Size"} set to ${fit.width}×${fit.height}`, moved ? `${c.width}×${c.height} put on its grid of ${spec.grid}, ${spec.min} to ${spec.max} px a side${spec.maxPixels ? ", within the pixels the model takes" : ""}. ${where}` : where);
        }
        const value = c.cmd === "length" ? c.seconds : c.value;
        if (spec.type === "number" && !(spec.auto && value === 0) && (value < spec.min || value > spec.max)) return say({ id: "bar:form", tone: "bad", title: `${spec.label} goes from ${spec.min} to ${spec.max}`, href: "/", go: "Open the Studio" });
        t.set(spec.id, value);
        good(`${spec.label || c.cmd} set to ${value}`, where);
      };
      const said = c.cmd === "size" ? `${c.width}×${c.height}` : c.cmd === "length" ? `${c.seconds} s` : String(c.value);
      return [{ label: `Set ${c.cmd === "cfg" ? "CFG" : c.cmd} to ${said}`, icon: <PenLine size={14} />, note: "in the open draft", run: set }];
    }
    case "generate": {
      // on a machine named this once (with several ComfyUIs), as Generate's machine slice would send it
      const m = c.machine ? machineByName(queue?.machines, c.machine) : undefined;
      if (c.machine && !m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <Play size={14} />, disabled: true, run: () => {} }];
      return [{
        label: m ? `Generate on ${machineLabel(m)}` : "Generate", icon: <Play size={14} />, note: m ? "the open draft, on that machine this once" : "the open draft, as its Generate button",
        run: () => form().then((t) => (t?.generate ? t.generate(m?.id) : noDraft())),
      }];
    }
    case "preset":
      if (!preset) return [{ label: `No preset called “${c.name}”`, disabled: true, run: () => {} }];
      return [
        { label: `Apply ${preset.name}`, icon: <Bookmark size={14} />, note: "on the open draft", run: () => applyPreset(x, preset) },
        { label: `Open ${preset.name} in the Prompt kit`, icon: <Clapperboard size={14} />, run: () => go(kitHref("preset", preset.id)) },
      ];
    case "save-preset":
      return [{
        label: `Save as preset “${c.name}”`, icon: <Bookmark size={14} />, note: "the open draft's model, form and cast",
        run: async () => {
          const t = await form();
          if (!t?.savePreset) return noDraft();
          await t.savePreset(c.name).then(() => good(`${c.name} saved as a preset`, `From the open draft (${t.recipe.title}).`, kitHref("preset"), "Open the Prompt kit"), failed(`${c.name} could not be saved`));
        },
      }];
    case "load": {
      if (!recipe) return [{ label: `No model called “${c.model}”`, disabled: true, run: () => {} }];
      const run = async () => {
        const open = useFormTarget.getState().target;
        const status = x.setup.data?.recipes.find((r) => r.id === recipe.id);
        const stored = open?.recipe.id === recipe.id ? open.values : {};
        const input = wholeForm(recipe, status, x.modelSettings.data?.items ?? [], stored);
        await api.warm(recipe.id, input, open?.recipe.id === recipe.id ? open.look ?? null : null);
        void client.invalidateQueries({ queryKey: queryKeys.queue() });
        good(`${recipe.title}: loading its models`, "A job in the queue that renders nothing.", "/queue", "Open queue");
      };
      return [{ label: `Load ${recipe.title}`, icon: <MemoryStick size={14} />, note: "into ComfyUI, ahead of a render", run: () => run().catch(failed(`${recipe.title} could not be loaded`)) }];
    }
    case "machines":
      return [{ label: "Show the ComfyUIs", icon: <Server size={14} />, note: "the status bar's panel", disabled: !queue?.machines?.length || queue.machines.length < 2, run: () => window.dispatchEvent(new Event(OPEN_MACHINES)) }];
    case "machine-log":
    case "machine-times":
    case "machine-models": {
      // one machine's view, by its name: the page opened on it (Queue.tsx, useTimesView.ts, ModelsMachines.tsx read it)
      const m = machineByName(queue?.machines, c.machine);
      if (!m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <Server size={14} />, disabled: true, run: () => {} }];
      const name = machineLabel(m);
      const id = encodeURIComponent(m.id);
      if (c.cmd === "machine-log") return [{ label: `ComfyUI log of ${name}`, icon: <Server size={14} />, note: m.online === false ? "it does not answer" : "its console", run: () => go(`/queue?view=log&machine=${id}`) }];
      if (c.cmd === "machine-times") return [{ label: `Render times of ${name}`, icon: <Server size={14} />, run: () => go(`/queue?view=times&machine=${id}`) }];
      return [{ label: `Models on ${name}`, icon: <Server size={14} />, note: "Settings › Models, its tab", run: () => go(`/settings/models?machine=${id}`) }];
    }
    case "start-pod":
    case "stop-pod": {
      // a rented pod, by its name: Start (the user's own, its rate said) or Stop, asked first as its card and menu do (a
      // render on it is lost). A name that starts two pods' names gives a row for each: never one picked for the user
      const pods = machinesByName(queue?.machines, c.machine).filter((m) => m.rented);
      if (!pods.length) return [{ label: `No rented pod called ${c.machine}`, icon: <Server size={14} />, disabled: true, run: () => {} }];
      return pods.map((m) => {
        const r = m.rented!;
        const name = machineLabel(m);
        if (c.cmd === "start-pod") {
          const can = r.status === "EXITED" || r.status === "ERROR";
          return { label: `Start ${name}…`, icon: <Server size={14} />, note: r.capped ? "a spending cap is reached" : !can ? rentedSaid(r) : rateSaid(r), disabled: !can || r.capped, run: () => void rented.askStart(m) };
        }
        return { label: `Stop ${name}…`, icon: <Server size={14} />, note: r.status !== "RUNNING" ? rentedSaid(r) : m.running ? "its render is lost" : r.diskPerDay > 0.005 ? `the disk keeps billing ${usd(r.diskPerDay)}/day` : "the GPU stops billing", disabled: r.status !== "RUNNING", run: () => void rented.askStop(m) };
      });
    }
    case "deploy-gpu":
      // the dialog: what RunPod has free now; nothing is billed before its Deploy
      return [{ label: "Deploy a GPU…", icon: <Server size={14} />, note: "RunPod · what is free now", run: () => openDeploy() }];
    case "deploy-again":
      return [{ label: "Deploy again", icon: <Server size={14} />, note: deployAgain.last ? "its rate asked first" : "nothing deployed yet: the dialog opens", disabled: deployAgain.run.isPending, run: () => (deployAgain.last ? deployAgain.run.mutate() : openDeploy()) }];
    case "hunt-gpu":
      // the Deploy dialog on its hunt; a hunt under way opens on its own choices, to change them
      return [{ label: "Hunt a GPU…", icon: <Server size={14} />, note: "RunPod · the best GPU that comes free", run: () => openDeploy("hunt") }];
    case "cancel-hunt":
      return [{ label: "Cancel the hunt", icon: <X size={14} />, danger: true, note: "the home machines it paused go on", run: () => cancelHunt(client).catch(failed("Could not cancel the hunt")) }];
    case "open-comfy": {
      // the first ComfyUI, or the one named: its own page (locked, through its login: lock-api.ts pageUrl)
      const m = c.machine ? machineByName(queue?.machines, c.machine) : queue?.machines[0];
      if (c.machine && !m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <Server size={14} />, disabled: true, run: () => {} }];
      // The machines not read yet (or none set up): off, rather than a guessed id that names a removed machine.
      if (!m) return [{ label: "Open ComfyUI", icon: <Server size={14} />, note: queue ? "no ComfyUI set up" : "the machines are not read yet", disabled: true, run: () => {} }];
      return [{ label: c.machine ? `Open ComfyUI on ${machineLabel(m)}` : "Open ComfyUI", icon: <Server size={14} />, note: "its own page, in a new tab", disabled: m.online === false && !m.locked, run: () => openComfy.mutate(m.id) }];
    }
    case "load-panel": {
      // the panel by the status bar (LoadPanel.tsx), on the machine named when there is one
      const m = c.machine ? machineByName(queue?.machines, c.machine) : undefined;
      if (c.machine && !m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <MemoryStick size={14} />, disabled: true, run: () => {} }];
      return [{ label: m ? `Load a model on ${machineLabel(m)}…` : "Load a model…", icon: <MemoryStick size={14} />, note: "this form's, a draft's, any by name", disabled: m?.online === false, run: () => openLoadPanel(m?.id) }];
    }
    case "unload": {
      if (c.machine) {
        // one machine of several, by its name: its lane's Unload, on the same conditions
        const m = machineByName(queue?.machines, c.machine);
        if (!m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <MemoryStick size={14} />, disabled: true, run: () => {} }];
        const why = machineUnloadBlock(m);
        return [{ label: `Unload ${machineLabel(m)}`, icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "its next render loads what it needs", run: () => ops.unload.mutate(m.id) }];
      }
      // the Queue page's button, on the same conditions
      const why = unloadBlock(queue);
      return [{ label: "Unload models", icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "the next render loads what it needs", run: () => ops.unload.mutate() }];
    }
    case "new-draft":
      if (!recipe) return [{ label: `No model called “${c.recipe}”`, disabled: true, run: () => {} }];
      return [{ label: `New draft on ${recipe.title}`, icon: <Sparkles size={14} />, run: () => api.createDraft({ recipe: recipe.id }).then(x.openNew, failed("Could not make the draft")) }];
    case "new-timeline":
      return [{
        label: c.name ? `New timeline “${c.name}”` : "New timeline", icon: <Film size={14} />, note: "in the project and folder you work in; opens in the editor",
        run: () => api.createTimeline(c.name || undefined, projectForNew(), openFolderId()).then((t) => { void client.invalidateQueries({ queryKey: queryKeys.timelines.all() }); x.reindex(); go(`/timelines/${t.id}`); }, failed("Could not make the timeline")),
      }];
    case "new-folder": {
      // at the top of the project worked in (in its root folder), as the Projects panel's "New folder inside…" on it
      const project = useProject.getState().id;
      const group = project && project !== "none" ? project : null;
      const p = group ? x.allProjects.find((y) => y.id === group) : undefined;
      const root = p?.folderId ?? null;
      const name = p?.name ?? "the Inbox";
      return [{
        label: `New folder “${c.name}” in ${name}`, icon: <FolderPlus size={14} />,
        run: () => tree.newFolder({ name, parent: root, project: group, typed: c.name }).then((made) => {
          if (!made) return;
          x.reindex();
          good(`${c.name} made`, `In ${name}.`);
        }),
      }];
    }
    case "new-person":
    case "new-place":
    case "new-style":
    case "new-preset":
    case "new-snippet": {
      const kind = KIT_OF[c.cmd as KitNew];
      return [{
        label: `New ${KIT_WORD[kind]} “${c.name}”`, icon: <Clapperboard size={14} />, note: "opens in the Prompt kit",
        run: () => api.createEntity(kind, c.name, kind === "snippet" ? { text: "", category: "", style: null } : undefined)
          .then((e) => { void client.invalidateQueries({ queryKey: queryKeys.entities() }); go(kitHref(kind, e.id)); }, failed(`${c.name} could not be made`)),
      }];
    }
    case "import-workflow":
      return [{
        label: "Import workflow…", icon: <FileUp size={14} />, note: "the file picker of the Workflows screen",
        run: () => {
          useWorkflowsRequest.getState().ask({ do: "import" });
          go("/workflows");
        },
      }];
    case "view-last":
      return [{
        label: "View last render", icon: <Eye size={14} />, note: "what the last finished job made",
        run: async () => {
          // what it made is not in the queue's figures: asked for now, as the status bar's "last:" does
          const done = (await api.jobs({ status: "done", limit: 10 })).items;
          const id = done.flatMap((j) => j.made.filter((m) => !m.inBin)).at(0)?.id;
          if (id) await x.view(id);
          else say({ id: "bar:last", tone: "bad", title: "Nothing finished lately is in the library", href: "/queue", go: "Open queue" });
        },
      }];
    case "reconnect":
      return [{
        label: "Reconnect to ComfyUI", icon: <Plug size={14} />, note: "as Settings' Test again",
        run: () => ops.reconnect.mutate(),
      }];
    case "pause":
    case "resume":
    case "use-only": {
      // one machine of several, by its name: its lane's Pause, Resume or Use only
      if (c.machine) {
        const m = machineByName(queue?.machines, c.machine);
        const Icon = c.cmd === "resume" ? Play : Pause;
        if (!m) return [{ label: `No ComfyUI called ${c.machine}`, icon: <Icon size={14} />, disabled: true, run: () => {} }];
        const name = machineLabel(m);
        if (c.cmd === "use-only") return [{ label: `Use only ${name}`, icon: <Play size={14} />, note: "every other ComfyUI paused", run: () => ops.useOnly.mutate(m.id) }];
        if (c.cmd === "pause") return [{ label: `Pause ${name}`, icon: <Pause size={14} />, disabled: m.paused, note: m.paused ? "already paused" : "finishes what it runs", run: () => ops.pause.mutate(m.id) }];
        return [{ label: `Resume ${name}`, icon: <Play size={14} />, disabled: !m.paused, note: m.paused ? undefined : "it is not paused", run: () => ops.resume.mutate(m.id) }];
      }
      if (c.cmd === "pause") return [{ label: "Pause queue", icon: <Pause size={14} />, disabled: queue?.paused, note: queue?.paused ? "already paused" : undefined, run: () => ops.pause.mutate() }];
      return [{ label: "Resume queue", icon: <Play size={14} />, disabled: queue ? !queue.paused : false, note: queue && !queue.paused ? "it is running" : undefined, run: () => ops.resume.mutate() }];
    }
    // the bin's own Empty the bin and Put all back (binActions.ts, as its strip over the grid), off while it is empty
    case "empty-bin":
      return [{
        label: "Empty the bin…", icon: <Trash2 size={14} />, danger: true, disabled: x.binEmpty, note: x.binEmpty ? "the bin is empty" : `${x.binSaid} · asked first; cannot be undone`,
        run: () => emptyAll(client),
      }];
    case "put-back-all":
      return [{
        label: "Put all back", icon: <Undo2 size={14} />, disabled: x.binEmpty, note: x.binEmpty ? "the bin is empty" : `${x.binSaid} · each back where it was`,
        run: () => restoreAll(client),
      }];
    case "link-folder": {
      const project = useProject.getState().id;
      const group = project && project !== "none" ? project : null;
      const name = group ? x.projects.find((p) => p.id === group)?.name ?? "the project" : "the Inbox";
      const t: Target = { kind: "group", group, root: null, name };
      return [{
        label: c.path ? `Link ${c.path} to ${name}` : `Link a folder of your disk to ${name}…`, icon: <Link2 size={14} />, note: "used in place, nothing copied",
        run: () => tree.link(t, c.path || undefined),
      }];
    }
    case "split":
    case "previous-take":
    case "next-take": {
      const clip = x.selectedClip;
      if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
      // the editor is on screen (a clip is selected in it): it does it as its keys do, and says in its note when it cannot
      const request: TimelineRequest = c.cmd === "split" ? { timeline: clip.timeline, do: "split" } : { timeline: clip.timeline, do: "take", by: c.cmd === "next-take" ? 1 : -1 };
      const run = () => useTimelineRequest.getState().ask(request);
      // the editor's key for it, read from the key table, drawn on the action's right
      if (c.cmd === "split") return [{ label: `Split clip ${clip.number} at playhead`, icon: <Split size={14} />, keys: rowKeys("split"), run }];
      const next = c.cmd === "next-take";
      return [{ label: `Clip ${clip.number}: ${next ? "next" : "previous"} take`, icon: next ? <ChevronRight size={14} /> : <ChevronLeft size={14} />, keys: rowKeys("take", next ? 1 : 0), run }];
    }
    case "mirror-pin": {
      const clip = x.selectedClip;
      if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
      if (!clip.pins.length) return [{ label: `Clip ${clip.number} has no pinned frame`, disabled: true, run: () => {} }];
      // one row a pinned frame, as its right-click menu's Mirror: `mirror pin off` offers only to turn it off
      return clip.pins.map((p) => {
        const on = c.off ? false : !p.on;
        const words = PIN_WORDS[p.where];
        return {
          label: on ? `Mirror ${words}` : `Mirror ${words} off`, icon: <FlipHorizontal2 size={14} />,
          disabled: Boolean(p.why) || (c.off && !p.on), note: p.why ?? (c.off && !p.on ? "not mirrored" : `clip ${clip.number} · at render time`),
          run: () => void clip.mirror(p.input, on).catch(failed("Could not change the mirror")),
        };
      });
    }
    case "cancel-waiting": {
      const ids = queue?.waiting.map((w) => w.id) ?? [];
      return [{
        label: "Cancel all waiting…", icon: <Trash2 size={14} />, danger: true, disabled: !ids.length, note: ids.length ? `${ids.length} · asked first · the running one goes on` : "nothing waits",
        run: () => x.bulk.cancelAllWaiting({ ids }).then((n) => n && good(`${plural(n, "waiting job")} cancelled`, "In the history as cancelled: Requeue brings one back.", "/queue", "Open queue")),
      }];
    }
    case "retry-failed": {
      // the failures the queue lists (newest first, as `!` shows them): queued again oldest first
      const ids = queue?.failed ?? [];
      return [{
        label: "Retry all failed", icon: <RotateCcw size={14} />, disabled: !ids.length, note: ids.length ? `${ids.length} · the same jobs, oldest first` : "none failed",
        run: () => x.bulk.retryAllFailed(ids).then((r) => r?.ids.length && good(`${plural(r.ids.length, "failed job")} queued again`, undefined, "/queue", "Open queue")),
      }];
    }
    case "dismiss-failed": {
      const ids = queue?.failed ?? [];
      return [{
        label: "Dismiss all failed…", icon: <X size={14} />, danger: true, disabled: !ids.length, note: ids.length ? `${ids.length} · off the history, asked first` : "none failed",
        run: () => x.bulk.dismissAllFailed({ ids, ask: true }).then((n) => n && good(`${plural(n, "failed job")} dismissed`, "Nothing left the library.", "/queue", "Open queue")),
      }];
    }
    case "group-queue":
      return [{
        label: "Group by model", icon: <Layers size={14} />, note: "same model together, the loaded one first",
        run: () => x.bulk.groupQueueByModel().then((done) => (done ? good("Queue grouped by model", "Same model together, the loaded one first.", "/queue", "Open queue") : done === false && good("Grouping saves no load", "The queue stays as it is.", "/queue", "Open queue"))),
      }];
    case "undo": {
      // the open editor's history first, as Ctrl+Z there; elsewhere the newest banner's Undo (a move, a bin), as Ctrl+Z off the editor
      if (aim?.open) {
        const what = client.getQueryData<{ undo?: string | null }>(queryKeys.timelines.one(aim.id))?.undo ?? null;
        return [{ label: what ? `Undo: ${what}` : `Nothing to undo in ${aim.name}`, icon: <Undo2 size={14} />, disabled: !what, note: what ? `in ${aim.name}, as its Ctrl+Z` : undefined, keys: what ? "Ctrl+Z" : undefined, run: () => useTimelineRequest.getState().ask({ timeline: aim.id, do: "undo" }) }];
      }
      const banner = [...useBanners.getState().items].reverse().find((b) => b.action?.undo);
      return [{
        label: banner ? `Undo: ${banner.title}` : "Nothing to undo", icon: <Undo2 size={14} />, disabled: !banner, note: banner ? "as the banner's Undo" : undefined, keys: banner ? "Ctrl+Z" : undefined,
        run: () => {
          if (!banner) return;
          useBanners.getState().dismiss(banner.id);
          banner.action!.run();
        },
      }];
    }
    case "clip": {
      if (!aim) return [noTimeline];
      const n = c.number;
      const over = aim.entry && n > aim.entry.clips;
      return [{
        label: over ? `${aim.name} has ${plural(aim.entry!.clips, "clip")}` : `Go to clip ${n} of ${aim.name}`, icon: <Film size={14} />, disabled: Boolean(over),
        note: over ? undefined : "selected, the playhead on its start",
        run: () => askTimeline(aim, { timeline: aim.id, do: "select", clip: n }),
      }];
    }
    case "transition": {
      const clip = x.selectedClip;
      if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
      if (c.kind === undefined) return [{ label: `No transition called “${c.words}”`, disabled: true, run: () => {} }];
      // the cut into the selected clip, as its join's choice in the column: on a cut only, and none before the first clip
      const why = clip.cutIn === "none" ? `clip ${clip.number} is the first: no cut before it` : clip.cutIn === "extends" ? `clip ${clip.number} extends clip ${clip.number - 1}: a transition goes on a cut` : null;
      const label = c.kind ? `Clip ${clip.number}: ${TRANSITIONS[c.kind].label} on its cut` : `Clip ${clip.number}: plain cut`;
      const same = clip.transition === c.kind;
      return [{
        label, icon: <Film size={14} />, disabled: Boolean(why) || same, note: why ?? (same ? "it is already" : "the cut from the clip before · Undo takes it back"),
        run: () => void clip.setTransition(c.kind!).catch(failed("Could not change the transition")),
      }];
    }
    case "slow-motion": {
      const clip = x.selectedClip;
      if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
      // its menu's Slow motion ×2 and ×4: a new take of the whole clip, which the editor queues
      return (c.factor === 4 ? [4, 2] : [2, 4]).map((f) => ({
        label: `Clip ${clip.number}: slow motion ×${f}`, icon: <Gauge size={14} />, disabled: !clip.slow, note: clip.slow ? (f === 2 ? "half speed, as a new take; sound slowed too" : "a quarter speed, as a new take") : "it has no take to slow",
        run: () => clip.slow?.(f as 2 | 4),
      }));
    }
    case "motion-windows": {
      const clip = x.selectedClip;
      if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
      return [{
        label: `Clip ${clip.number}: Motion transfer in windows`, icon: <Film size={14} />, disabled: !clip.toSource,
        note: clip.toSource ? "the source lane: what it plays, made into clips" : "only a video brought in (no model of its own)",
        run: () => clip.toSource?.(),
      }];
    }
    case "stop-all-pods": {
      // every rented pod that bills now (running or on its way up), stopped as its card's Stop: asked first, since a render on one is lost
      const pods = (queue?.machines ?? []).filter((m) => billing(m.rented));
      const rendering = pods.filter((m) => m.running).length;
      return [{
        label: pods.length ? `Stop all pods · ${pods.length}…` : "No pod runs or starts", icon: <Square size={14} />, danger: true, disabled: !pods.length,
        note: pods.length ? `${pods.map(machineLabel).join(", ")}${rendering ? ` · ${rendering === 1 ? "its render is" : `${rendering} renders are`} lost` : ""} · disks go on billing` : undefined,
        run: async () => {
          const yes = await ask({
            title: `Stop ${pods.length === 1 ? machineLabel(pods[0]!) : `all ${pods.length} pods`}?`,
            text: `${rendering ? `${rendering === 1 ? "The render on it is" : `The ${rendering} renders on them are`} lost. ` : ""}Their GPUs stop billing now; their disks keep billing until they are terminated (Settings › Rented GPUs).`,
            yes: "Stop",
          });
          if (!yes) return;
          // one at a time: each says what failed in its own banner (useRentedOps), and one refused does not stop the others
          for (const m of pods) await rented.stop.mutateAsync({ machine: m.id, how: "stop" }).catch(() => {});
        },
      }];
    }
    case "spending":
      // the Costs page first (where it went, this PC's electricity too); the caps on Ctrl+Enter
      return [
        { label: "Open Queue › Costs", icon: <CircleDollarSign size={14} />, note: "where the money went, by project and render", run: () => go("/queue?view=costs") },
        { label: "Open Settings › Rented GPUs", icon: <CircleDollarSign size={14} />, note: "the caps and the balance", run: () => go(settingHref("comfy.rentcaps")) },
      ];
    case "sign-out": {
      const why = signOutBlock(x.access);
      // as the Access card's Sign out on this device: the session ends, and the page read again shows the sign-in
      return [{
        label: "Sign out", icon: <LogOut size={14} />, disabled: Boolean(why), note: why ?? "this browser · the sign-in page comes next",
        run: () => api.signOut().then(() => location.reload(), failed("Could not sign out")),
      }];
    }
    case "sign-out-everywhere":
      return [{
        label: "Sign out everywhere…", icon: <LogOut size={14} />, danger: true, disabled: !x.access?.locked, note: x.access?.locked ? "every device, this one too · asked first" : "no password is set",
        run: async () => {
          // the card's question, as its two-step button asks it
          const yes = await ask({ title: "Sign out every device, this one too?", text: "Each device needs the password again to come back in.", yes: "Sign out everywhere" });
          if (!yes) return;
          await api.signOutEverywhere(false).then(() => (x.access?.session ? location.reload() : good("Every device signed out", "This computer stays in: it needs no password.", settingHref("access"), "Open Access")), failed("Could not sign out everywhere"));
        },
      }];
    case "find-models": {
      // as Settings › Models' Find models…: what is picked downloads onto this PC; online only with lookups on
      const lookups = Boolean(x.settingCtx.server?.civitaiLookups);
      return [{
        label: c.words ? `Find models: “${c.words}”` : "Find models…", icon: <Search size={14} />, disabled: !lookups,
        note: lookups ? "Civitai, Hugging Face and yours · to download onto this PC" : "turn on Search Hugging Face and Civitai (Settings › Models) first",
        run: () => openFindModels(onThisPc(x), c.words || undefined),
      }];
    }
    case "picked":
      return pickedActions(x);
    case "get-missing":
      return missingActions(x);
    case "model-updates": {
      // as the card's Check now, then the card (its list opens from there)
      const lookups = Boolean(x.settingCtx.server?.civitaiLookups);
      return [{
        label: "Model updates", icon: <Download size={14} />, disabled: !lookups,
        note: lookups ? "Civitai asked now, then the list" : "turn on Search Hugging Face and Civitai (Settings › Models) first",
        run: async () => {
          go(settingHref("models.updates"));
          try {
            const report = await api.checkModelUpdates();
            client.setQueryData(queryKeys.modelUpdates(), report);
            const newer = report.items.filter((u) => u.newer).length;
            good(newer ? `${plural(newer, "model")} with a newer version on Civitai` : "Your models are the newest on Civitai", report.error ?? undefined, settingHref("models.updates"), "Open the list");
          } catch (err) {
            failed("Could not ask Civitai")(err);
          }
        },
      }];
    }
    case "check-updates":
      return [{
        label: "Check for updates", icon: <Download size={14} />, note: "GitHub asked now, as About's Check now",
        run: async () => {
          // what it finds is said even with the daily checks off (as About's Check now)
          useUpdatesSeen.getState().ask();
          try {
            const v = await api.checkUpdates();
            client.setQueryData(queryKeys.updates(), v);
            if (v.newer && v.latest) say({ id: "bar:updates", tone: "good", title: `Afflatus ${v.latest.version} is out`, text: `You have ${v.version}. > update, or Settings › About.`, href: settingHref("about.updates"), go: "Open About" });
            else if (v.checkError) failed("Could not ask GitHub")(new Error(v.checkError));
            // a build that is no release (dev, a checkout) is told the latest release rather than that it is it
            else good(v.latest && v.latest.version !== v.version ? `The latest release is ${v.latest.version}` : `Afflatus ${v.version} is the latest`, v.latest && v.latest.version !== v.version ? `You run ${v.version}.` : undefined, settingHref("about.updates"), "Open About");
          } catch (err) {
            failed("Could not check for updates")(err);
          }
        },
      }];
    case "update": {
      const v = x.updates;
      if (!v?.newer || !v.latest) return [{ label: "Update Afflatus", icon: <Download size={14} />, disabled: true, note: v ? `you have ${v.version}, the latest known` : "not read yet", run: () => {} }];
      return [
        {
          label: `Update to ${v.latest.version}`, icon: <Download size={14} />, disabled: !v.canUpdate, note: v.canUpdate ? "Afflatus restarts once the queue is empty; your library stays as it is" : v.cannot ?? "not from here",
          // About's Update: the steps go on in the background and the restart is followed as there
          run: () => api.startUpdate().then((view) => {
            client.setQueryData(queryKeys.updates(), view);
            followRestart(view.version, view.flow);
          }, failed("Could not update")),
        },
        { label: "Open Settings › About", icon: <Download size={14} />, note: "the release notes", run: () => go(settingHref("about.updates")) },
      ];
    }
    case "go-back": {
      const prev = x.updates?.previous;
      if (!prev) return [{ label: "No previous version kept", icon: <Undo2 size={14} />, disabled: true, run: () => {} }];
      return [{
        label: `Go back to ${prev.version}…`, icon: <Undo2 size={14} />, disabled: !x.updates?.here, note: x.updates?.here ? "asked first · Afflatus restarts" : "only on the computer Afflatus runs on",
        run: async () => {
          // About's Go back, with its question (refused while a rented GPU runs or a hunt is on)
          const yes = await askGoBack(prev.version).catch(failed("Could not go back"));
          if (!yes) return;
          await api.goBack().then((view) => {
            client.setQueryData(queryKeys.updates(), view);
            followRestart(view.version, view.flow);
          }, failed("Could not go back"));
        },
      }];
    }
    case "test-notify": {
      // as each channel's Send a test: one action a channel set up, the one named first
      const n = x.settingCtx.server?.notify;
      const set = { telegram: Boolean(n?.hasTelegramToken && n.telegramChat), discord: Boolean(n?.hasDiscordWebhook) };
      const send = (ch: "telegram" | "discord") => api.testNotify(ch).then(() => good(`Test sent to ${ch === "telegram" ? "Telegram" : "Discord"}`, "Look for it there.", settingHref(`notify.${ch}`), "Open the settings"), failed(`Could not send to ${ch === "telegram" ? "Telegram" : "Discord"}`));
      const all = (["telegram", "discord"] as const).map((ch) => ({
        label: `Send a test to ${ch === "telegram" ? "Telegram" : "Discord"}`, icon: <Bell size={14} />, disabled: !set[ch], note: set[ch] ? undefined : "not set up (Settings › Interface)",
        run: () => send(ch),
      }));
      // the one named alone; else those set up first
      return c.channel ? all.filter((a) => a.label.endsWith(c.channel === "telegram" ? "Telegram" : "Discord")) : [...all.filter((a) => !a.disabled), ...all.filter((a) => a.disabled)];
    }
    case "new-project":
      return [{
        label: `New project “${c.name}”`, icon: <FolderPlus size={14} />, note: "and work in it",
        run: () => api.createProject(c.name).then((p) => { void client.invalidateQueries({ queryKey: queryKeys.projects.all() }); useProject.getState().set(p.id); good(`${p.name} made`, "You work in it now: what you make lands in its root folder."); }, failed("Could not make the project")),
      }];
  }
}
