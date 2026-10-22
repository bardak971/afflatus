import { useQuery } from "@tanstack/react-query";
import { Music } from "lucide-react";
import { api, fileUrl, thumbUrl, type AssetDetail, type CommandEntry, type RecipeInfo } from "../api";
import { removedName } from "@afflatus/core";
import { useRecipes, useTimeline } from "../data";
import { mainTextOf } from "../form";
import { clock, plural, recipeLabel, size, took, when } from "../format";
import { cx } from "../ui";
import { timelineLength, type Item } from "./items";
import type { SettingCtx } from "./settingsRegistry";
import { pageLabel, valueSaid } from "./settingsRegistry";
import { queryKeys } from "../queryKeys";

type Fact = { k: string; v: string };

/**
 * A recipe as the previews name it: under its model's name ("H3 · Text to video"), one taken out of Afflatus by the name it
 * had; never an id ("model h3" said the family's id).
 */
function useModelOf(recipes: RecipeInfo[]): (id: string) => string {
  const families = useRecipes().data?.families;
  return (id) => {
    const r = recipes.find((x) => x.id === id);
    return r ? recipeLabel(families?.find((f) => f.id === r.family)?.name, r.title) : removedName(id) ?? id;
  };
}

/** The facts of a result, two to a row, the values in the mono face. */
function Facts({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-3.5 gap-y-2 text-xs">
      {facts.map((f) => (
        <div key={f.k} className="flex min-w-0 flex-col gap-px">
          <dt className="text-ink-3">{f.k}</dt>
          <dd className="m-0 truncate font-mono text-ink">{f.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Title({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-base font-bold text-ink-strong">{title}</span>
      {sub && <span className="text-[12.5px] text-ink-2">{sub}</span>}
    </div>
  );
}

function TextCard({ children }: { children: string }) {
  return <div className="max-h-56 overflow-y-auto rounded-xl border border-line bg-panel p-3.5 text-[13.5px] leading-relaxed whitespace-pre-line text-ink">{children}</div>;
}

/** A render: its frame, or the video playing muted in a loop (from the file the library's cards play on hover). */
function RenderPreview({ e, detail, recipes }: { e: Extract<CommandEntry, { kind: "asset" }>; detail: AssetDetail | undefined; recipes: RecipeInfo[] }) {
  const g = detail?.generation;
  const recipe = g ? recipes.find((r) => r.id === g.recipe) : undefined;
  const modelOf = useModelOf(recipes);
  const seed = g?.resolved.seed ?? (typeof g?.inputs.seed === "number" && g.inputs.seed >= 0 ? g.inputs.seed : undefined);
  const facts: Fact[] = [
    ...(g ? [{ k: "model", v: modelOf(g.recipe) }] : []),
    ...(seed !== undefined ? [{ k: "seed", v: String(seed) }] : []),
    ...(typeof g?.inputs.steps === "number" ? [{ k: "steps", v: String(g.inputs.steps) }] : []),
    ...(e.width && e.height ? [{ k: "frame", v: `${e.width}×${e.height}` }] : []),
    ...(e.durationMs && e.assetKind !== "image" ? [{ k: "length", v: clock(e.durationMs, { decimals: 1 }) }] : []),
    { k: "file", v: size(e.bytes) },
    ...(g?.tookMs ? [{ k: "took", v: took(g.tookMs) }] : []),
    { k: "made", v: when(e.updatedAt) },
  ];
  const ratio = e.width && e.height ? Math.max(0.5, Math.min(2.2, e.width / e.height)) : 16 / 9;
  return (
    <>
      <div data-stage className="relative flex h-[230px] items-center justify-center overflow-hidden rounded-xl bg-stage">
        {e.assetKind === "audio" ? (
          <span className="flex flex-col items-center gap-2 text-ink-2"><Music size={28} />Sound · {e.durationMs ? clock(e.durationMs) : ""}</span>
        ) : (
          <span className="relative h-full max-w-full" style={{ aspectRatio: ratio }}>
            {e.hasThumb && <img src={thumbUrl(e.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />}
            {e.assetKind === "video" && <video key={e.id} src={fileUrl(e.id)} muted autoPlay loop playsInline preload="auto" aria-label="Playing, muted" className="absolute inset-0 h-full w-full object-contain" />}
          </span>
        )}
      </div>
      <Title title={e.label} sub={detail?.generation ? `Made with ${recipe?.title ?? modelOf(g!.recipe)}` : e.assetKind === "image" ? "Image" : e.assetKind === "video" ? "Video" : "Sound"} />
      <Facts facts={facts} />
    </>
  );
}

/** A timeline: its clips as a strip (each as long as it plays; a clip with nothing rendered yet hatched), and its facts. */
function TimelinePreview({ e }: { e: Extract<CommandEntry, { kind: "timeline" }> }) {
  const t = useTimeline(e.id).data;
  const clips = t?.clips ?? [];
  return (
    <>
      <div className="flex h-24 gap-1">
        {(clips.length ? clips.slice(0, 12) : Array.from({ length: Math.min(e.clips, 12) }, () => null)).map((c, i) => {
          const asset = c?.take?.asset ?? c?.still ?? null;
          return (
            <div
              key={c?.id ?? i}
              style={{ flexGrow: Math.max(1, (c?.lengthMs ?? 1000) / 1000), backgroundImage: asset ? undefined : "repeating-linear-gradient(45deg, var(--color-raised) 0 6px, var(--color-panel) 6px 12px)" }}
              className="relative min-w-6 basis-0 overflow-hidden rounded-lg bg-raised"
            >
              {asset && <img src={thumbUrl(asset.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
              <span className="absolute bottom-1 left-1.5 rounded bg-stage/70 px-1 font-mono text-[10px] text-ink">c{i + 1}</span>
            </div>
          );
        })}
        {!e.clips && <div className="flex grow items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-ink-3">No clips yet</div>}
      </div>
      <Title title={e.label} sub={`Timeline · edited ${when(e.updatedAt)}`} />
      <Facts facts={[
        { k: "clips", v: String(e.clips) },
        { k: "length", v: timelineLength(e) },
        { k: "unused takes", v: e.unusedTakes ? `${e.unusedTakes} · ${size(e.unusedBytes)}` : "none" },
        { k: "export", v: e.exported ? "done" : "not yet" },
        ...(t?.width && t.height ? [{ k: "frame", v: `${t.width}×${t.height}` }] : []),
        ...(clips.length ? [{ k: "to render", v: String(clips.filter((c) => c.kind === "video" && !c.take).length) }] : []),
      ]} />
    </>
  );
}

/** A draft: its prompt, and what it is on. */
function DraftPreview({ e, recipes }: { e: Extract<CommandEntry, { kind: "draft" }>; recipes: RecipeInfo[] }) {
  const d = useQuery({ queryKey: queryKeys.drafts.one(e.id), queryFn: ({ signal }) => api.draft(e.id, { signal }) }).data;
  const recipe = recipes.find((r) => r.id === (d?.recipe ?? e.recipe));
  const modelOf = useModelOf(recipes);
  const form = d && recipe ? d.forms[recipe.id] ?? {} : {};
  const main = recipe ? mainTextOf(recipe) : undefined;
  const text = main ? String(form[main.id] ?? "").trim() : "";
  const sizeV = form.size as { width?: number; height?: number } | undefined;
  return (
    <>
      <TextCard>{d ? text || "No prompt yet." : "…"}</TextCard>
      <Title title={e.label} sub={`Draft · ${modelOf(d?.recipe ?? e.recipe)}`} />
      <Facts facts={[
        { k: "renders", v: String(e.renders) },
        { k: "last", v: when(e.updatedAt) },
        ...(sizeV?.width && sizeV.height ? [{ k: "size", v: `${sizeV.width}×${sizeV.height}` }] : []),
        ...(typeof form.seconds === "number" ? [{ k: "length", v: `${form.seconds} s` }] : []),
        ...(typeof form.seed === "number" && form.seed >= 0 ? [{ k: "seed", v: String(form.seed) }] : []),
        ...(d?.look?.cast.length ? [{ k: "cast", v: String(d.look.cast.length) }] : []),
      ]} />
    </>
  );
}

/** What the selected row is, larger: only drawn once it stayed selected a moment (see CommandBar). */
export function Preview({ item, detail, recipes, settingCtx, extra }: {
  item: Item;
  detail: AssetDetail | undefined;
  recipes: RecipeInfo[];
  settingCtx: SettingCtx;
  /** What a command says it will do (its estimate, its targets). */
  extra?: { text: string; facts: Fact[] };
}) {
  const e = item.entry;
  const modelOf = useModelOf(recipes);
  let body;
  if (e?.kind === "asset") body = <RenderPreview e={e} detail={detail} recipes={recipes} />;
  else if (e?.kind === "timeline") body = <TimelinePreview e={e} />;
  else if (e?.kind === "draft") body = <DraftPreview e={e} recipes={recipes} />;
  else if (e?.kind === "project") body = (
    <>
      <TextCard>{e.archived ? "Archived: hidden from the lists, everything kept. Unarchive it to work in it." : `Work in ${e.label}: renders land in its root folder; the Studio and Timelines show its drafts and timelines.`}</TextCard>
      <Title title={e.label} sub="Project" />
      <Facts facts={[{ k: "timelines", v: String(e.timelines) }, { k: "items", v: String(e.items) }, { k: "size", v: size(e.bytes) }, { k: "changed", v: when(e.updatedAt) }]} />
    </>
  );
  else if (e?.kind === "folder") body = (
    <>
      <TextCard>{`${plural(e.items, "item")} here${e.linked ? ", in a folder of your disk: used where they are." : "."}`}</TextCard>
      <Title title={e.label} sub={item.meta} />
      <Facts facts={[{ k: "items", v: String(e.items) }, { k: "kind", v: e.linked ? "on your disk" : "folder" }]} />
    </>
  );
  else if (item.kind === "setting" && item.setting) {
    const s = item.setting;
    const v = valueSaid(s, settingCtx);
    body = (
      <>
        <TextCard>{s.about ?? `On the ${pageLabel(s.page)} page of Settings.`}</TextCard>
        <Title title={s.label} sub={`Settings › ${pageLabel(s.page)}${s.scope === "this browser" ? " · this browser" : ""}`} />
        <Facts facts={[...(v ? [{ k: "now", v }] : []), ...(s.scope ? [{ k: "kept", v: s.scope === "Afflatus" ? "by Afflatus" : "this browser" }] : [])]} />
      </>
    );
  } else if (item.kind === "job" && item.job) {
    const { job, state, position } = item.job;
    const run = state === "running" ? (job as { progress?: number; step?: number; steps?: number }) : null;
    body = (
      <>
        <TextCard>{state === "failed" ? job.error ?? "It failed." : state === "running" ? "Rendering now." : `Waiting, ${position === 1 ? "next" : `number ${position}`} in line.`}</TextCard>
        <Title title={job.label} sub={`${job.kind === "render" ? "Render" : job.kind === "export" ? "Export" : job.kind === "load" ? "Model load" : "Cut"} · ${state}`} />
        <Facts facts={[
          ...(run?.progress ? [{ k: "progress", v: `${Math.round(run.progress * 100)} %` }] : []),
          ...(run?.steps ? [{ k: "step", v: `${run.step} of ${run.steps}` }] : []),
          ...(job.estimateMs ? [{ k: "estimate", v: took(job.estimateMs) }] : []),
          { k: "queued", v: when(job.createdAt) },
        ]} />
      </>
    );
  } else if (item.kind === "history" && item.history) {
    const h = item.history;
    body = (
      <>
        {h.assetId && <div data-stage className="flex h-40 items-center justify-center overflow-hidden rounded-xl bg-stage"><img src={thumbUrl(h.assetId)} alt="" className="h-full object-contain" /></div>}
        <TextCard>{h.prompt}</TextCard>
        <Facts facts={[{ k: "model", v: modelOf(h.recipe) }, { k: "rendered", v: when(h.createdAt) }]} />
      </>
    );
  } else if (item.kind === "person" && item.person) {
    const p = item.person;
    const pic = p.def.pictures[0];
    body = (
      <>
        {pic && <div data-stage className="flex h-48 items-center justify-center overflow-hidden rounded-xl bg-stage"><img src={thumbUrl(pic)} alt="" className="h-full object-contain" /></div>}
        <Title title={p.name} sub="A person of the Prompt kit" />
        <Facts facts={[{ k: "pictures", v: String(p.def.pictures.length) }, { k: "voice", v: p.def.voice ? "yes" : "none" }]} />
      </>
    );
  } else body = (
    <>
      {extra?.text && <TextCard>{extra.text}</TextCard>}
      <Title title={item.label} sub={item.meta} />
      <Facts facts={extra?.facts ?? []} />
    </>
  );
  return (
    <aside aria-label="Preview" className={cx("flex w-[380px] shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-line bg-panel/60 p-[18px]", "animate-bar-fade motion-reduce:animate-none")}>
      {body}
    </aside>
  );
}
