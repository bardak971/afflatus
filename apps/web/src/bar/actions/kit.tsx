import { Bookmark, Clapperboard, Copy, Eye, PenLine, Search, UserPlus } from "lucide-react";
import type { CommandEntry, PromptHistoryItem } from "../../api";
import { mainTextOf } from "../../form";
import { kitHref } from "../../screens/kit/link";
import { copyText } from "../../secureContext";
import { castPlace, withPerson } from "../castTo";
import type { Action, BarCtx, Person } from "./ctx";
import { retype } from "./retype";
import { valueText } from "../search";

/** A preset of the Prompt kit on the open draft, as the form's preset menu applies it (refused the same way). */
export async function applyPreset(x: BarCtx, p: { id: string; name: string }) {
  const t = await x.form();
  if (!t?.applyPreset) return x.noDraft();
  const refused = t.applyPreset(p.id);
  if (refused) return x.say({ id: "bar:preset", tone: "bad", title: `${p.name} could not be applied`, text: refused, href: "/", go: "Open the Studio" });
  x.good(`${p.name} applied`, `To the open draft (${t.recipe.title}).`);
}

/** Where `@name` and a person of the kit go: the clip selected in the open timeline editor first, else the open draft. */
function castActions(x: BarCtx, p: Person): Action[] {
  const { good, failed, selectedClip } = x;
  const toDraft: Action = {
    label: "Add to the open draft", icon: <UserPlus size={14} />, note: "its cast",
    run: async () => {
      const t = await x.form();
      if (!t?.setLook) return x.noDraft();
      const look = withPerson(t.look ?? null, p.id);
      if (!look) return good(`${p.name} is already in the draft`);
      t.setLook(look);
      good(`${p.name} added to the draft`, `In the cast of ${t.recipe.title}.`);
    },
  };
  // the clip selected in the open timeline editor first, when its model takes a person
  const clip = selectedClip && castPlace(selectedClip).to === "clip" ? selectedClip : null;
  const toClip: Action[] = clip ? [{
    label: `Add to clip ${clip.number} of ${clip.timelineName}`, icon: <UserPlus size={14} />, note: clip.own ? "its cast" : "its own cast, from the timeline's",
    run: async () => {
      const look = withPerson(clip.look, p.id);
      if (!look) return good(`${p.name} is already in clip ${clip.number}`, clip.own ? undefined : "In the timeline's cast, which the clip follows.", `/timelines/${clip.timeline}`, "Open the timeline");
      await clip.setLook(look).then(() => good(`${p.name} added to clip ${clip.number}`, `In its cast, for ${clip.recipe?.title ?? "its model"}.`, `/timelines/${clip.timeline}`, "Open the timeline"), failed(`${p.name} could not be added to clip ${clip.number}`));
    },
  }] : [];
  return [...toClip, ...(!clip || x.draftOpen ? [toDraft] : [])];
}

/** A thing of the Prompt kit: opened there, and what its kind does from the bar (a preset applied, a snippet copied, a person cast). */
export function kitActions(x: BarCtx, k: Extract<CommandEntry, { kind: "kit" }>): Action[] {
  const entity = x.entities.find((e) => e.id === k.id);
  const open: Action = { label: "Open in the Prompt kit", icon: <Clapperboard size={14} />, run: () => x.go(kitHref(k.entity, k.id)) };
  if (k.entity === "preset") return [open, { label: "Apply in Studio", icon: <Bookmark size={14} />, note: "on the open draft", run: () => applyPreset(x, { id: k.id, name: k.label }) }];
  if (k.entity === "snippet") {
    const text = entity?.kind === "snippet" ? entity.def.text : "";
    return [open, { label: "Copy its text", icon: <Copy size={14} />, stay: true, disabled: !text, note: text ? text.slice(0, 60) : "empty", run: () => copyText(text).then(() => x.onCopied(`${k.label}`), () => x.onCopied("")) }];
  }
  if (k.entity === "person" && entity?.kind === "person") return [open, ...castActions(x, entity)];
  return [open];
}

/** A person of `@`: cast where the bar casts, or opened in the kit. */
export const personActions = (x: BarCtx, p: Person): Action[] => [...castActions(x, p), { label: `Open ${p.name} in the Prompt kit`, icon: <Clapperboard size={14} />, run: () => x.go(kitHref("person", p.id)) }];

/**
 * A prompt of the history: what it made opened first (a clip's take on its timeline, the clip selected; any other render
 * in the viewer), else its draft; then put in the open draft, its renders searched, or copied.
 */
export function historyActions(x: BarCtx, h: PromptHistoryItem): Action[] {
  const seen: Action[] = h.clip
    ? [{ label: `Open clip ${h.clip.clip} on its timeline`, icon: <Eye size={14} />, run: () => x.go(`/timelines/${h.clip!.timeline}?clip=${h.clip!.clip}`) }]
    : h.assetId ? [{ label: "View its render", icon: <Eye size={14} />, run: () => x.view(h.assetId!).catch(x.failed("Could not open it")) }] : [];
  return [
    ...seen,
    ...(h.draftId ? [{ label: "Open its draft", icon: <PenLine size={14} />, run: () => x.openDraft(h.draftId!) }] : []),
    ...(h.clip && h.assetId ? [{ label: "View its render", icon: <Eye size={14} />, note: "the take alone", run: () => x.view(h.assetId!).catch(x.failed("Could not open it")) }] : []),
    {
      label: "Use in the open draft", icon: <PenLine size={14} />, note: "its main prompt",
      run: async () => {
        const t = await x.form();
        const main = t ? mainTextOf(t.recipe) : undefined;
        if (!t || !main) return x.say({ id: "bar:form", tone: "bad", title: "No draft with a prompt is open", href: "/", go: "Open the Studio" });
        t.set(main.id, h.prompt);
        x.good("Prompt put in the open draft", h.prompt.slice(0, 120));
      },
    },
    // its renders: the line's prompt: with its first words (the library's words find those that hold them all)
    { label: "Its renders", icon: <Search size={14} />, note: "prompt: with its first words", stay: true, run: retype(`prompt:${valueText(h.prompt.replace(/["\s]+/g, " ").trim().split(" ").slice(0, 6).join(" "))} `) },
    { label: "Copy the prompt", icon: <Copy size={14} />, stay: true, run: () => copyText(h.prompt).then(() => x.onCopied("the prompt"), () => x.onCopied("")) },
  ];
}
