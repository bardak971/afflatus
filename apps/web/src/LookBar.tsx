import { useState, type MouseEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, MapPin, Plus, Sparkles, User, X } from "lucide-react";
import { LIMITS } from "@afflatus/core";
import { api, lookAdds, thumbUrl, type Entity, type Look, type RecipeInfo } from "./api";
import { useEntities } from "./data";
import { fileLabel } from "./format";
import { useSettled } from "./hooks";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { kitHref } from "./screens/kit/link";
import { outfitsOf } from "./screens/kit/shared";
import { Select } from "./Select";
import { cx, Help } from "./ui";

const none: Look = { cast: [], style: null, snippets: [] };

/**
 * Who is in it and how it looks: people and places as chips (a person with the outfit picked), and one
 * style. They are written once, in the Prompt kit; here they are only picked. "See what is sent"
 * shows what they add for the model in use: words, LoRAs, reference pictures, a voice.
 */
export function LookBar({ look, onChange, recipe, input, title = "Characters and styles" }: {
  look: Look | null;
  onChange(look: Look): void;
  /** With a recipe and its form, "See what is sent" is offered. */
  recipe?: RecipeInfo;
  input?: Record<string, unknown>;
  title?: string;
}) {
  const entities = useEntities();
  const [, go] = useLocation();
  const [showing, setShowing] = useState(false);
  // the menu of a chip of the cast: under the chip when clicked, at the pointer when right-clicked
  const [menu, setMenu] = useState<{ at: { x: number; y: number; keyed?: boolean }; id: string } | null>(null);
  const all = entities.data?.items ?? [];
  // someone deleted from the kit is left out: not shown, not counted, and gone with the next change
  const now = present(look ?? none, entities.data ? all : null);
  const castable = all.filter((e) => (e.kind === "person" || e.kind === "place") && !now.cast.some((c) => c.id === e.id)).sort((a, b) => a.kind.localeCompare(b.kind));
  const styles = all.filter((e) => e.kind === "style");
  const active = lookAdds(now);
  // asked once the typing has settled, not once per keystroke
  const settled = useSettled(input, 500);
  const sent = useQuery({
    queryKey: ["compose", recipe?.id, settled, now],
    queryFn: () => api.compose(recipe!.id, settled ?? {}, now),
    enabled: showing && active && Boolean(recipe),
  });
  const main = recipe?.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe?.inputs.find((i) => i.type === "prompt");
  const subject = recipe?.inputs.find((i) => i.type === "prompt" && i.holds === "subject");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold">{title}</span>
        <Link href={kitHref("person")} className="text-xs text-ink-2 underline hover:text-ink">{all.some((e) => e.kind !== "preset") ? "Edit in the Prompt kit" : "Add people, places and styles"}</Link>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {now.cast.map((member) => {
          const e = all.find((x) => x.id === member.id);
          if (!e || (e.kind !== "person" && e.kind !== "place")) return null;
          const worn = e.kind === "person" ? e.def.outfits.find((o) => o.id === member.outfit) : undefined;
          const face = e.def.pictures[0];
          const opens = (ev: MouseEvent<HTMLButtonElement>, below: boolean) => {
            ev.preventDefault();
            const r = ev.currentTarget.getBoundingClientRect();
            // from the keyboard (Enter, the menu key), its first item is active at once
            setMenu({ id: e.id, at: below || (ev.clientX === 0 && ev.clientY === 0) ? { x: r.left, y: r.bottom + 4, keyed: ev.detail === 0 } : { x: ev.clientX, y: ev.clientY } });
          };
          return (
            <button
              key={e.id}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu?.id === e.id}
              aria-label={`${e.name}${worn ? `, ${worn.name}` : ""}: outfit, open in the kit, remove`}
              onClick={(ev) => opens(ev, true)}
              onContextMenu={(ev) => opens(ev, false)}
              className={cx("flex h-9 items-center gap-1.5 rounded-full border border-accent bg-accent-wash pr-2 pl-1 hover:bg-hover", menu?.id === e.id && "bg-hover")}
            >
              {face ? <img src={thumbUrl(face)} alt="" className="h-7 w-7 rounded-full object-cover" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-raised text-ink-2">{e.kind === "person" ? <User size={13} /> : <MapPin size={13} />}</span>}
              <span className="font-semibold">{e.name}</span>
              {worn && <span className="text-xs text-ink-2">· {worn.name}</span>}
              <ChevronDown size={13} className="shrink-0 text-ink-2" />
            </button>
          );
        })}
        {menu && (() => {
          const e = all.find((x) => x.id === menu.id);
          if (!e || (e.kind !== "person" && e.kind !== "place")) return null;
          const member = now.cast.find((c) => c.id === e.id);
          const wear = (outfit: string | null) => onChange({ ...now, cast: now.cast.map((c) => (c.id === e.id ? { ...c, outfit } : c)) });
          const outfits: MenuItem[] = e.kind === "person"
            ? [
              { label: "As in the references", icon: !member?.outfit ? <Check size={14} /> : undefined, run: () => wear(null) },
              ...outfitsOf(e.def.outfits).map((o): MenuItem => ({ label: o.name || "Unnamed outfit", icon: member?.outfit === o.id ? <Check size={14} /> : undefined, run: () => wear(o.id) })),
              "—",
            ]
            : [];
          const items: MenuItem[] = [
            ...outfits,
            { label: `Open ${e.name} in the kit`, icon: <ExternalLink size={14} />, run: () => go(kitHref(e.kind, e.id)) },
            { label: "Remove from the cast", icon: <X size={14} />, danger: true, run: () => onChange({ ...now, cast: now.cast.filter((c) => c.id !== e.id) }) },
          ];
          return <ContextMenu at={menu.at} label={`${e.name} in the cast`} head={{ title: e.name, sub: e.kind === "person" ? "Person · outfit" : "Place", thumb: e.def.pictures[0] }} items={items} onClose={() => setMenu(null)} />;
        })()}
        {/* as many as a look holds: the server refuses more, and every save of the draft would fail */}
        {castable.length > 0 && now.cast.length < LIMITS.cast && (
          <div className="w-28">
            <Select
              dashed
              size="sm"
              className="h-9"
              icon={<Plus size={13} className="shrink-0" />}
              label="Add a person or a place"
              placeholder="Add"
              value=""
              onChange={(id) => onChange({ ...now, cast: [...now.cast, { id }] })}
              options={castable.map((e) => ({ value: e.id, label: e.name, group: e.kind === "person" ? "People" : "Places" }))}
            />
          </div>
        )}
        {styles.length > 0 && (
          <div className="w-40">
            <Select
              size="sm"
              className={cx("h-9", now.style && "border-accent")}
              icon={<Sparkles size={13} className="shrink-0 text-ink-2" />}
              label="Style"
              value={now.style ?? ""}
              onChange={(id) => onChange({ ...now, style: id || null })}
              options={[{ value: "", label: "No style" }, ...styles.map((e) => ({ value: e.id, label: e.name }))]}
            />
          </div>
        )}
        {now.cast.length >= LIMITS.cast && <span className="flex items-center gap-1.5 text-xs text-ink-3">Cast full · {LIMITS.cast}/{LIMITS.cast} <Help title="Cast" text={`One image or clip takes at most ${LIMITS.cast} people and places. Take one out to add another.`} /></span>}
        {!castable.length && !styles.length && !now.cast.length && <span className="flex items-center gap-1.5 text-xs text-ink-3">No people, places or styles yet <Help title="Prompt kit" text="A person is written once in the Prompt kit (reference images, a voice sample, prompt text, a LoRA per model) and used with every model." /></span>}
      </div>
      {active && recipe && (
        <button type="button" aria-expanded={showing} onClick={() => setShowing(!showing)} className="self-start text-xs text-ink-2 underline hover:text-ink">
          {showing ? "Hide final prompt" : "Show final prompt"}
        </button>
      )}
      {showing && active && recipe && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised p-2.5 text-xs">
          {sent.isLoading && <span className="text-ink-2">Composing…</span>}
          {sent.isError && <span className="text-warn-ink">{sent.error.message}</span>}
          {sent.data && (
            <>
              {main && <span><span className="text-ink-2">{main.label}: </span><Marked text={String(sent.data.input[main.id] ?? "")} added={sent.data.added.words} /></span>}
              {subject && sent.data.input[subject.id] ? <span><span className="text-ink-2">{subject.label}: </span><Marked text={String(sent.data.input[subject.id])} added={sent.data.added.words} /></span> : null}
              {sent.data.added.loras.length > 0 && <span><span className="text-ink-2">LoRAs added: </span>{sent.data.added.loras.map((l) => `${fileLabel(l.file)} (${l.from})`).join(", ")}</span>}
              {sent.data.added.references > 0 && <span><span className="text-ink-2">Reference images added: </span>{sent.data.added.references}</span>}
              {sent.data.added.voice && <span><span className="text-ink-2">Voice sample: </span>{sent.data.added.voice}</span>}
              {!sent.data.added.words.length && !sent.data.added.loras.length && !sent.data.added.references && !sent.data.added.voice && <span className="text-ink-2">Nothing of them fits this model: no prompt text, LoRA or reference images are set for it.</span>}
              {sent.data.added.skipped.map((s) => <span key={s} className="text-warn-ink">{s}</span>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A look without the people, places, style and snippets no longer in the kit (as it is while the kit loads). */
function present(look: Look, all: Entity[] | null): Look {
  if (!all) return look;
  const has = (id: string, kinds: Entity["kind"][]) => all.some((e) => e.id === id && kinds.includes(e.kind));
  const cast = look.cast.filter((c) => has(c.id, ["person", "place"]));
  const style = look.style && has(look.style, ["style"]) ? look.style : null;
  const snippets = (look.snippets ?? []).filter((id) => has(id, ["snippet"]));
  return cast.length === look.cast.length && style === (look.style ?? null) && snippets.length === (look.snippets ?? []).length ? look : { ...look, cast, style, snippets };
}

/** A text with the parts that came from the cast or the style in their colour. */
function Marked({ text, added }: { text: string; added: Array<{ from: string; text: string }> }) {
  const parts: Array<{ text: string; from?: string }> = [{ text }];
  for (const a of added) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const at = p.from ? -1 : p.text.indexOf(a.text);
      if (at < 0) continue;
      parts.splice(i, 1, { text: p.text.slice(0, at) }, { text: a.text, from: a.from }, { text: p.text.slice(at + a.text.length) });
      break;
    }
  }
  return <>{parts.map((p, i) => (p.from ? <span key={i} data-tip={`from ${p.from}`} className="text-accent">{p.text}</span> : <span key={i}>{p.text}</span>))}</>;
}

/** The names of a look, for a line of text: "Her, The terrace · Film look". */
export function lookWords(look: Look | null, all: Entity[]): string {
  if (!look) return "";
  const names = look.cast.map((c) => all.find((e) => e.id === c.id)?.name).filter(Boolean).join(", ");
  const style = all.find((e) => e.id === look.style)?.name;
  return [names, style].filter(Boolean).join(" · ");
}
