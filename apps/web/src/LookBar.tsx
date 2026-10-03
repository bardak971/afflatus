import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Plus, Sparkles, User, X } from "lucide-react";
import { api, thumbUrl, type Entity, type Look, type RecipeInfo } from "./api";
import { useEntities } from "./data";
import { fileLabel } from "./format";
import { Select } from "./Select";
import { cx } from "./ui";

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
  const [showing, setShowing] = useState(false);
  const all = entities.data?.items ?? [];
  const now = look ?? none;
  const castable = all.filter((e) => (e.kind === "person" || e.kind === "place") && !now.cast.some((c) => c.id === e.id)).sort((a, b) => a.kind.localeCompare(b.kind));
  const styles = all.filter((e) => e.kind === "style");
  const active = now.cast.length > 0 || Boolean(now.style) || Boolean(now.snippets?.length);
  const sent = useQuery({
    queryKey: ["compose", recipe?.id, input, now],
    queryFn: () => api.compose(recipe!.id, input ?? {}, now),
    enabled: showing && active && Boolean(recipe),
  });
  const main = recipe?.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe?.inputs.find((i) => i.type === "prompt");
  const subject = recipe?.inputs.find((i) => i.type === "prompt" && i.holds === "subject");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold">{title}</span>
        <Link href="/kit#people" className="text-xs text-ink-2 underline hover:text-ink">{all.some((e) => e.kind !== "preset") ? "Edit in the Prompt kit" : "Add people, places and styles"}</Link>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {now.cast.map((member) => {
          const e = all.find((x) => x.id === member.id);
          if (!e || (e.kind !== "person" && e.kind !== "place")) return null;
          const outfits = e.kind === "person" ? e.def.outfits : [];
          const worn = outfits.find((o) => o.id === member.outfit);
          const face = e.def.pictures[0];
          return (
            <span key={e.id} className="flex h-9 items-center gap-1.5 rounded-full border border-accent bg-accent-wash pr-1 pl-1">
              {face ? <img src={thumbUrl(face)} alt="" className="h-7 w-7 rounded-full object-cover" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-raised text-ink-2">{e.kind === "person" ? <User size={13} /> : <MapPin size={13} />}</span>}
              <span className="font-semibold">{e.name}</span>
              {outfits.length > 0 && (
                <button
                  type="button"
                  title={`Outfit: ${worn?.name ?? "as in the reference images"}. Click for the next one.`}
                  aria-label={`Outfit of ${e.name}: ${worn?.name ?? "as in the reference images"}. Click for the next one.`}
                  onClick={() => {
                    const order = [null, ...outfits.map((o) => o.id)];
                    const next = order[(order.indexOf(member.outfit ?? null) + 1) % order.length];
                    onChange({ ...now, cast: now.cast.map((c) => (c.id === e.id ? { ...c, outfit: next } : c)) });
                  }}
                  className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink-2 hover:text-ink"
                >
                  {worn?.name ?? "as in the references"}
                </button>
              )}
              <button type="button" aria-label={`Remove ${e.name}`} onClick={() => onChange({ ...now, cast: now.cast.filter((c) => c.id !== e.id) })} className="flex h-6 w-6 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"><X size={12} /></button>
            </span>
          );
        })}
        {castable.length > 0 && (
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
        {!castable.length && !styles.length && !now.cast.length && <span className="text-xs text-ink-3">None yet. A person is written once (reference images, a voice sample, prompt text) and used with every model.</span>}
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
  return <>{parts.map((p, i) => (p.from ? <span key={i} title={`from ${p.from}`} className="text-accent">{p.text}</span> : <span key={i}>{p.text}</span>))}</>;
}

/** The names of a look, for a line of text: "Her, The terrace · Film look". */
export function lookWords(look: Look | null, all: Entity[]): string {
  if (!look) return "";
  const names = look.cast.map((c) => all.find((e) => e.id === c.id)?.name).filter(Boolean).join(", ");
  const style = all.find((e) => e.id === look.style)?.name;
  return [names, style].filter(Boolean).join(" · ");
}
